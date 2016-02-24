#!/usr/bin/env node
var vdev = require("../vdev");

var ops = vdev.ops;

// var cmd = (process.argv.length >= 3)? process.argv[2] : null;

// var params = (process.argv.length >= 4)? process.argv.slice(3): [];


var cmds = {
	scaffold: function(basePackage,appName){
		vdev.scaffold.init("./", basePackage, appName);
	}, 

	// --------- Ops Server ParentDir --------- //
	makeServer: function(appName){
		ops.makeServer(appName);
	}, 

	makeWarRepo: function(appName){
		ops.makeWarRepo(appName);
	}, 
	// --------- /Ops Server ParentDir --------- //

	// --------- Ops ServerDir --------- //
	makePostReceive: function(){
		ops.makePostReceive();
	}, 
	// --------- /Ops ServerDir --------- //


	test: function(){
		console.log("vdev test called");
	}
};

vdev.execCmd(cmds);