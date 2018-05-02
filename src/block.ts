import * as fs from 'fs-extra-plus';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { saferRemove, now, printLog, Partial, asNames } from './utils';
import { spawn } from 'p-spawn';
import { async as glob } from 'fast-glob';
import { rollupFiles, pcssFiles, tmplFiles } from './processors';
import { loadVdevConfig } from './vdev-config';


// --------- Public Types --------- //
export interface Block {
	name: string;
	dir: string;
	webBundles?: WebBundle[];
	baseDistDir?: string;
	dbuildDependencies?: string | string[];
	[key: string]: any;

}

export interface WebBundle {
	name: string;
	entries: string | string[];
	rollupOptions?: any;
	dist: string; // distribution file path (from .dir)


	type?: string; // set in the buildWebBundles
	dir?: string; // set in the initWebBundle
	allEntries: string[]; // set in the initWebBundle
}

export type BlockByName = { [name: string]: Block };
// --------- /Public Types --------- //

export async function updateVersions() {
	const config: any = await loadVdevConfig();
	const versionFiles = config.version.files;

	const packageJson = await fs.readJSON('./package.json');

	// for now, the appVersion == dropVersion (later might have a suffix)
	const newAppVersion = packageJson.dropVersion;

	let firstUpdate = false; // flag that will be set 

	for (let file of versionFiles) {
		const originalContent = (await fs.readFile(file, 'utf8')).toString();
		const fileAppVersion = getVarValue(originalContent, 'appVersion');

		if (newAppVersion !== fileAppVersion) {
			// On the first update needed, we start the log section for the version update
			if (!firstUpdate) {
				console.log(`----- Version Update: Updating new appVersion to ${newAppVersion} `);
				firstUpdate = true;
			}

			console.log(`Changing appVersion ${fileAppVersion} -> ${newAppVersion} in file: ${file}`);
			let newContent = replaceVarValue(originalContent, 'appVersion', newAppVersion);
			await fs.writeFile(file, newContent, 'utf8');
		} else {
			// Note: for now, we do not log when nothing to do.
			// console.log(`appVersion ${newAppVersion} match (nothing to do) in file: ${file}`);
		}
	}
	// if we have at least one update, we close the log section.
	if (firstUpdate) {
		console.log('----- /Version Update: done');
	}
}


// FIXME: Needs to look at the "blocks" from the config
export async function cleanNodeFiles() {
	const filesToDelete = ['./package-lock.json', './node_blockules'];
	// FIXME: need to get the blocks
	var dirs = await fs.listDirs(`services`, false);
	// dirs.unshift('./'); // we do not clean the base dir, as it is easy to do by hand, and then, scripts won't work
	// TODO: probably need to add web-server as well

	for (let dir of dirs) {
		for (let fName of filesToDelete) {
			const fileToDelete = path.join(dir, fName);
			if ((await fs.pathExists(fileToDelete))) {
				saferRemove(fileToDelete);
			}
		}
	}
}

/**
 * 
 * @param names List of block name or block/bundle names
 */
export async function buildBlocksOrBundles(names: string[]) {
	if (names.length === 0) {
		const blocks = await loadBlocks();
		for (let block of Object.values(blocks)) {
			await _buildBlock(block);
		}
	} else {
		for (let name of names) {
			const blockAndBundle = name.split('/');
			// if only .length === 1 then blockAndBundle[1] which is fine
			await buildBlock(blockAndBundle[0], blockAndBundle[1]);
		}
	}
}


// TODO: need to add support for any blockule watch
// TODO: needs to add support for only one bundle watch
export async function watchBlock(blockName: string) {
	const blocks = await loadBlocks();
	const block = blocks[blockName];

	const webBundles = (block) ? block.webBundles : null;
	if (webBundles == null) {
		throw new Error(`Block ${blockName} not found or does not have a '.webBundles'. As of now, can only watch webBundles`)
	}

	for (let bundle of webBundles) {
		await initWebBundle(block, bundle);

		// the rollup have a watch blocke, so we use it
		if (bundle.type === 'js' || bundle.type === 'ts') {
			await _buildBlock(block, bundle, { watch: true });
		}

		// otherwise, we just watch the entries, and rebuild everything
		else {
			await _buildBlock(block, bundle);
			let watcher = chokidar.watch(bundle.entries, { persistent: true });
			watcher.on('change', async function (filePath: string, stats) {
				if (filePath.endsWith(`.${bundle.type}`)) {
					await _buildBlock(block, bundle);
				}
			});
		}
	}
}

export interface BuildOptions {
	watch?: boolean; // for rollup bundles for now
	full?: boolean; // for maven for including unit test (not implemented yet)
}

/**
 * Build a and block and eventually a bundle
 * @param blockName 
 * @param opts 
 */
export async function buildBlock(blockName: string, onlyBundleName?: string, opts?: BuildOptions) {
	const blockByName = await loadBlocks();
	const block = blockByName[blockName];

	if (!block) {
		throw new Error(`No block found for blockeName ${blockName}.`);
	}

	let bundle: WebBundle | undefined;
	if (onlyBundleName && block.webBundles) {
		bundle = block.webBundles.find((b) => (b.name == onlyBundleName));
		if (!bundle) {
			throw new Error(`No webBundle ${onlyBundleName} found in block ${block.name}`);
		}
		await initWebBundle(block, bundle);
	}

	await _buildBlock(block, bundle, opts);
}

async function _buildBlock(block: Block, bundle?: WebBundle, opts?: BuildOptions) {

	const hasPomXml = await fs.pathExists(path.join(block.dir, 'pom.xml'));
	const hasPackageJson = await fs.pathExists(path.join(block.dir, 'package.json'));
	const hasDockerFile = await fs.pathExists(path.join(block.dir, 'Dockerfile'));
	const hasTsConfig = await fs.pathExists(path.join(block.dir, 'tsconfig.json'));
	const hasWebBundles = (block.webBundles) ? true : false;

	// Note: if we have a bundleName, then, just the bundle log will be enough.
	const start = now();
	if (!bundle) {
		console.log(`------ Building Block ${block.name} ${block.dir}`);
	}

	// no matter what, if we have a pckageJson, we make sure we do a npm install
	if (hasPackageJson) {
		await npmInstall(block);
	}

	// if we have a webBundles, we build it
	if (hasWebBundles) {
		// TODO: need to allow to give a bundle name to just build it
		await buildWebBundles(block, bundle, opts);
	}

	// only run tsc if it is not a webBundle (assume rollup will take care of the ts when webBundles)
	if (!hasWebBundles && hasTsConfig) {
		await runTsc(block);
	}

	if (hasPomXml) {
		await runMvn(block, opts ? opts.full : false);
	}

	if (!bundle) {
		await printLog(`------ Building Block ${block.name} DONE`, null, start);
		console.log();
	}
}


async function npmInstall(block: Block) {
	await spawn('npm', ['install'], { cwd: block.dir });
}

async function runTsc(block: Block) {
	await spawn('tsc', [], { cwd: block.dir });
}

async function runMvn(block: Block, full?: boolean) {
	const args = ['clean', 'package'];
	if (!full) {
		args.push('-Dmaven.test.skip=true');
	}

	var start = now();

	await spawn('mvn', args, {
		toConsole: false,
		cwd: block.dir,
		onStderr: function (data: any) {
			process.stdout.write(data);
		}
	});

	await printLog(`maven build ${full ? 'with test' : ''}`, null, start);
}


// --------- Private WebBundle Utils --------- //
type WebBundler = (block: Block, webBundle: WebBundle, opts?: BuildOptions) => void;
const bundlers: { [type: string]: WebBundler } = {
	ts: buildTsBundler,
	pcss: buildPcssBundler,
	tmpl: buildTmplBundler,
	js: buildJsBundler
}

async function buildWebBundles(block: Block, onlyBundle?: WebBundle, opts?: BuildOptions) {

	let webBundles: WebBundle[];

	if (onlyBundle) {
		// the onlyBundle is already initialized
		webBundles = [onlyBundle];
	} else {
		webBundles = block.webBundles!;
		// we need to initialize the webBundles
		for (let bundle of webBundles) {
			await initWebBundle(block, bundle);
		}
	}

	for (let bundle of webBundles!) {
		await ensureDist(bundle);
		var start = now();
		await bundlers[bundle.type!](block, bundle, opts);
		await printLog(`Building bundle ${block.name}/${bundle.name}`, bundle.dist, start);
	}
}

const rollupOptionsDefaults = {
	ts: {
		watch: false,
		ts: true,
		tsconfig: './tsconfig.json'
	},
	js: {
		watch: false,
		ts: false
	}
}

/**
 * Initialize all of the bundle properties accordingly. 
 * This allow the bundlers and other logic to not have to worry about default values and path resolution.
 */
async function initWebBundle(block: Block, bundle: WebBundle) {

	bundle.type = path.extname(asNames(bundle.entries)[0]).substring(1);

	// for now, just take the block.dir
	bundle.dir = specialPathResolve('', block.dir, bundle.dir);

	// Make the entries relative to the Block
	bundle.entries = asNames(bundle.entries).map((f) => specialPathResolve('', bundle.dir!, f));

	// resolve all of the entries (with glob)
	bundle.allEntries = (await glob(bundle.entries)).map(entryItem => (typeof entryItem === 'string') ? entryItem : entryItem.path);

	// resolve the dist
	bundle.dist = specialPathResolve('', block.baseDistDir!, bundle.dist);


	// --------- rollupOptions initialization --------- //
	if (bundle.type === 'ts' || bundle.type === 'js') {
		// get the base default options for this type
		const rollupOptionsDefault = rollupOptionsDefaults[bundle.type];

		// override default it if bundle has one
		const rollupOptions = (bundle.rollupOptions) ? { ...rollupOptionsDefault, ...bundle.rollupOptions }
			: { ...rollupOptionsDefault };

		// resolve tsconfig
		if (rollupOptions.tsconfig) {
			rollupOptions.tsconfig = specialPathResolve('', bundle.dir, rollupOptions.tsconfig);
		}

		// set the new optoins back.
		bundle.rollupOptions = rollupOptions;
	}
	// --------- /rollupOptions initialization --------- //

}
// --------- /Private WebBundle Utils --------- //

// --------- Private Bundlers --------- //
async function buildTsBundler(block: Block, bundle: WebBundle, opts?: BuildOptions) {
	// TODO: need to re-enable watch
	try {
		if (opts && opts.watch) {
			bundle.rollupOptions.watch = true;
		}
		await rollupFiles(bundle.allEntries, bundle.dist, bundle.rollupOptions);
	} catch (ex) {
		// TODO: need to move exception ahndle to the caller
		console.log("BUILD ERROR - something when wrong on rollup\n\t", ex);
		console.log("Empty string was save to the app bundle");
		console.log("Trying saving again...");
		return;
	}
}

async function buildPcssBundler(block: Block, bundle: WebBundle, opts?: BuildOptions) {
	await pcssFiles(bundle.allEntries, bundle.dist);
}

async function buildTmplBundler(block: Block, bundle: WebBundle, opts?: BuildOptions) {
	await tmplFiles(bundle.allEntries, bundle.dist);
}

async function buildJsBundler(block: Block, bundle: WebBundle, opts?: BuildOptions) {
	if (opts && opts.watch) {
		bundle.rollupOptions.watch = true;
	}
	await rollupFiles(bundle.allEntries, bundle.dist, bundle.rollupOptions);
}
// --------- /Private Bundlers --------- //

// --------- Public Loaders --------- //
export async function loadDockerBlocks(): Promise<BlockByName> {
	const blocks = await loadBlocks();
	const dockerBlocks: BlockByName = {};
	for (let block of Object.values(blocks)) {
		const hasDockerfile = await fs.pathExists(path.join(block.dir, 'Dockerfile'));
		if (hasDockerfile) {
			dockerBlocks[block.name] = block;
		}
	}
	return dockerBlocks;
}

export async function loadBlocks(): Promise<BlockByName> {
	const rawConfig = await loadVdevConfig();

	const rawBlocks = rawConfig.blocks;

	// build the services map from the raw services list
	const blockByName: { [name: string]: Block } = rawBlocks.map((item: string | any) => {
		let block: Partial<Block>;
		let name: string;

		if (typeof item === 'string') {
			block = {
				name: item
			}
		} else {
			if (!item.name) {
				throw new Error(`the build config file vdev.yaml has a block without '.name'`);
			}
			// we do a shallow clone			
			block = { ...item };
		}

		// if the block does not have a dir, then, build it with the parent one
		if (!block.dir) {
			block.dir = path.join(rawConfig.baseBlockDir, `${block.name}/`);
		}
		return block as Block;
	}).reduce((map: { [key: string]: Block }, block: Block) => {
		map[block.name] = block;
		return map;
	}, {});

	return blockByName;
}

export async function loadBlock(name: string): Promise<Block> {
	const blocks = await loadBlocks();
	const block = blocks[name];

	if (!block) {
		throw new Error(`Block ${name} not found`);
	}

	return block;
}


// --------- /Public Loaders --------- //

// --------- Private Utils --------- //

// Get the variable string value from a content of code. Format should be `name = "value"` (support also ':' rather than '=' for json), and te value will be returned.
// Used in version to get the `appVersion` from the code.
function getVarValue(content: string, name: string) {
	var rx = new RegExp(name + '\\s*[=:]\\s*"(.*)"', 'i');
	var match = content.match(rx);
	return (match) ? match[1] : null;
}

// Replace the string value of a variable name in a code content. Format same as getVarValue.
function replaceVarValue(content: string, name: string, value: string) {
	var rx = new RegExp('(.*' + name + '\\s*[=:]\\s*").*(".*)', 'i');
	content = content.replace(rx, '$1' + value + '$2');
	return content;
}

async function ensureDist(bundle: WebBundle) {
	const distDir = path.dirname(bundle.dist);
	await fs.ensureDir(distDir);
}

/**
 * Special resolve that 
 *   - if finalPath null, then, return dir. 
 *   - resolve any path to dir if it starts with './' or '../', 
 *   - absolute path if it starts with '/' 
 *   - baseDir if the path does not start with either '/' or './'
 * @param baseDir 
 * @param dir
 * @param finalPath dir or file path
 */
export function specialPathResolve(baseDir: string, dir: string, finalPath?: string): string {
	if (finalPath == null) {
		return dir;
	}

	if (finalPath.startsWith('/')) {
		return finalPath;
	}
	if (finalPath.startsWith('./') || finalPath.startsWith('../')) {
		return path.join(dir, finalPath)
	}
	return path.join(baseDir, finalPath);
}
// --------- /Private Utils --------- //