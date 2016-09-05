var assert = require('assert');
var async = require('async');
var fs = require('fs');
var solc = require('solc');
var TestRPC = require('ethereumjs-testrpc');
var Web3 = require('web3');

var web3 = new Web3();
var testRPC = TestRPC.provider();
web3.setProvider(testRPC);

var accounts = null;
var accountHashes = null;

function compileContract(filenames, contractname) {
	var sources = {}
	for(var i = 0; i < filenames.length; i++)
		sources[filenames[i]] = fs.readFileSync(filenames[i]).toString();
	var compiled = solc.compile({sources: sources}, 1);
	assert.equal(compiled.errors, undefined, compiled.errors);
	return compiled.contracts[contractname];
}

before(function(done) {
	web3.eth.getAccounts(function(err, acct) {
		accounts = acct
		accountHashes = accounts.map(function(x) { return web3.sha3(x, {encoding: 'hex'}).slice(0, 34); });		
		done();
	});
});

describe('DepositHolder', function() {
	var dh = null;

	beforeEach(function(done) {
		this.timeout(10000);
		dhContract = compileContract(['DepositHolder.sol'], 'DepositHolder');
		dh = web3.eth.contract(JSON.parse(dhContract.interface)).new(
			{
				from: accounts[0],
				data: dhContract.bytecode,
				gas: 4700000
			}, function(err, contract) {
				assert.equal(err, null, err);
				if(contract.address != undefined)
					done();
			});
	});

	it("records and refunds deposits", function(done) {
		var now = Math.floor(Date.now() / 1000);
		async.series([
			// Put down a deposit on two hashes
			function(done) {
				dh.deposit([accountHashes[0], accountHashes[1]], "100000000000000000",
					{from: accounts[0], value: "200000000000000000"}, done);
			},
			// Pause a bit and put down another deposit
			function(done) { web3.currentProvider.sendAsync({
				jsonrpc: "2.0",
				"method": "evm_increaseTime",
				params: [10]}, done);
			},
			function(done) {
				dh.deposit([accountHashes[2]], "200000000000000000",
					{from: accounts[0], value: "200000000000000000"}, done);
			},
			// Check the hashes are registered
			function(done) {
				dh.check(accounts[0], function(err, result) {
					assert.equal(err, null, err);
					var diff = result[0].toNumber() - now - 31536000;
					assert.ok(Math.abs(diff) <= 1, diff);
					assert.equal(result[1], "100000000000000000");
					done();
				});
			},
			function(done) {
				dh.check(accounts[2], function(err, result) {
					assert.equal(err, null, err);
					var diff = result[0].toNumber() - now - 31536010;
					assert.ok(Math.abs(diff) <= 1, diff);
					assert.equal(result[1], "200000000000000000");
					done();
				});
			},
			// Check nextWithdrawal returns as expected
			function(done) {
				dh.nextWithdrawal(0, function(err, result) {
					assert.equal(err, null, err);
					var diff = result[0].toNumber() - now - 31536000;
					assert.ok(Math.abs(diff) <= 1, diff);
					assert.equal(result[1].toNumber(), 2);
					assert.equal(result[2], "200000000000000000");
					assert.notEqual(result[3], "0x00000000000000000000000000000000");
					dh.nextWithdrawal(result[3], function(err, result) {
						assert.equal(err, null, err);
						var diff = result[0].toNumber() - now - 31536010;
						assert.ok(Math.abs(diff) <= 1, diff);
						assert.equal(result[1].toNumber(), 1);
						assert.equal(result[2], "200000000000000000");
						assert.equal(result[3], "0x00000000000000000000000000000000");
						done();
					})
				});
			},
			function(done) {
				dh.depositCount(function(err, result) {
					assert.equal(err, null, err);
					assert.equal(result.toNumber(), 3);
					done();
				});
			},
			// Wait for a deposit to expire, and check we can get it back.
			function(done) { web3.currentProvider.sendAsync({
				jsonrpc: "2.0",
				"method": "evm_increaseTime",
				params: [31535991]}, done);
			},
			function(done) {
				web3.eth.getBalance(accounts[0], function(err, startBalance) {
					dh.withdraw(10, {from: accounts[0]}, function(err, txid) {
						assert.equal(err, null, err);
						web3.eth.getBalance(accounts[0], function(err, endBalance) {
							var diff = endBalance.minus(startBalance).minus("200000000000000000").toNumber()
							assert.ok(Math.abs(diff) < 100000, diff);
							done();
						});
					});
				});
			},
			function(done) {
				dh.nextWithdrawal(0, function(err, result) {
					assert.equal(err, null, err);
					var diff = result[0].toNumber() - now - 31536010;
					assert.ok(Math.abs(diff) <= 1, diff);
					assert.equal(result[1].toNumber(), 1);
					assert.equal(result[2], "200000000000000000");
					assert.equal(result[3], "0x00000000000000000000000000000000");
					done();
				})
			},
			function(done) {
				dh.depositCount(function(err, result) {
					assert.equal(err, null, err);
					assert.equal(result.toNumber(), 1);
					done();
				});
			},
		], done);
	});

	it("pays out claims first", function(done) {
		async.series([
			// Put down a deposit on two hashes
			function(done) {
				dh.deposit([accountHashes[0], accountHashes[1]], "100000000000000000",
					{from: accounts[0], value: "200000000000000000"}, done);
			},
			// Make a claim and check it gets paid out
			function(done) {
				web3.eth.getBalance(accounts[1], function(err, startBalance) {
					dh.disburse(accounts[1], "50000000000000000", {from: accounts[0]}, function(err, txid) {
						assert.equal(err, null, err);
						web3.eth.getBalance(accounts[1], function(err, endBalance) {
							var diff = endBalance.minus(startBalance).minus("50000000000000000").toNumber()
							assert.ok(Math.abs(diff) < 10000, diff);
							done();
						});
					});
				});
			},
			// Check the contract balance
			function(done) {
				web3.eth.getBalance(dh.address, function(err, balance) {
					assert.equal(balance, "150000000000000000");
					done();
				});
			},
			// Check the paidOut variable
			function(done) {
				dh.paidOut(function(err, total) {
					assert.equal(err, null, err);
					assert.equal(total, "50000000000000000");
					done();
				});
			},
			// Wait for the deposit to expire.
			function(done) { web3.currentProvider.sendAsync({
				jsonrpc: "2.0",
				"method": "evm_increaseTime",
				params: [31536001]}, done);
			},
			// Withdraw and get the rest
			function(done) {
				web3.eth.getBalance(accounts[0], function(err, startBalance) {
					dh.withdraw(10, {from: accounts[0]}, function(err, txid) {
						assert.equal(err, null, err);
						web3.eth.getBalance(accounts[0], function(err, endBalance) {
							var diff = endBalance.minus(startBalance).minus("150000000000000000").toNumber()
							assert.ok(Math.abs(diff) < 100000, diff);
							done();
						});
					});
				});				
			}
		], done);
	});
});
