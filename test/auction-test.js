/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('./util/assert');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');

const network = Network.get('regtest');
const NAME1 = rules.grindName(20, network);

const workers = new WorkerPool({
  enabled: true
});

function createNode() {
  const chain = new Chain({
    memory: true,
    network,
    workers
  });

  const miner = new Miner({
    chain,
    workers
  });

  return {
    chain,
    miner,
    cpu: miner.cpu,
    wallet: () => {
      const wallet = new MemWallet({ network });

      chain.on('connect', (entry, block) => {
        wallet.addBlock(entry, block.txs);
      });

      chain.on('disconnect', (entry, block) => {
        wallet.removeBlock(entry, block.txs);
      });

      return wallet;
    }
  };
}

describe('Auction', function() {
  this.timeout(15000);

  describe('Vickrey Auction', function() {
    const node = createNode();
    const orig = createNode();
    const comp = createNode();

    const {chain, miner, cpu} = node;

    const winner = node.wallet();
    const runnerup = node.wallet();

    let snapshot = null;

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(winner.getReceive());
      miner.addAddress(runnerup.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a bid', async () => {
      const mtx1 = await winner.createBid(NAME1, 1000, 2000);
      const mtx2 = await runnerup.createBid(NAME1, 500, 2000);

      const job = await cpu.createJob();
      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should reveal a bid', async () => {
      const mtx1 = await winner.createReveal(NAME1);
      const mtx2 = await runnerup.createReveal(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a name', async () => {
      const mtx = await winner.createRegister(NAME1, Buffer.from([1,2,3]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register again and update tree', async () => {
      const mtx = await winner.createUpdate(NAME1, Buffer.from([1,2,4]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should redeem', async () => {
      const mtx = await runnerup.createRedeem(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      snapshot = {
        treeRoot: chain.tip.treeRoot,
        auction: await chain.cdb.getAuctionByName(NAME1)
      };
    });

    it('should open other nodes', async () => {
      await orig.chain.open();
      await orig.miner.open();
      await comp.chain.open();
      await comp.miner.open();
    });

    it('should clone the chain', async () => {
      for (let i = 1; i <= chain.height; i++) {
        const block = await chain.getBlock(i);
        assert(block);
        assert(await orig.chain.add(block));
      }
    });

    it('should mine a competing chain', async () => {
      while (comp.chain.tip.chainwork.lte(chain.tip.chainwork)) {
        const block = await comp.cpu.mineBlock();
        assert(block);
        assert(await comp.chain.add(block));
      }
    });

    it('should reorg the auction', async () => {
      let reorgd = false;

      chain.once('reorganize', () => reorgd = true);

/*
      chain.on('disconnect', async () => {
        const auction = await chain.cdb.getAuctionByName(NAME1);
        if (auction)
          console.log(auction.format(chain.height, network));
      });
*/

      for (let i = 1; i <= comp.chain.height; i++) {
        assert(!reorgd);
        const block = await comp.chain.getBlock(i);
        assert(block);
        assert(await chain.add(block));
      }

      assert(reorgd);

      const auction = await chain.cdb.getAuctionByName(NAME1);
      assert(!auction);
    });

    it('should reorg back to the correct state', async () => {
      let reorgd = false;

      chain.once('reorganize', () => reorgd = true);

/*
      chain.on('connect', async () => {
        const auction = await chain.cdb.getAuctionByName(NAME1);
        if (auction)
          console.log(auction.format(chain.height, network));
      });
*/

      while (!reorgd) {
        const block = await orig.cpu.mineBlock();
        assert(block);
        assert(await orig.chain.add(block));
        assert(await chain.add(block));
      }
    });

    it('should close other nodes', async () => {
      await orig.miner.close();
      await orig.chain.close();
      await comp.miner.close();
      await comp.chain.close();
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should have the same DB state', async () => {
      const auction = await chain.cdb.getAuctionByName(NAME1);
      assert(auction);

      assert.deepStrictEqual(auction, snapshot.auction);
      assert.strictEqual(chain.tip.treeRoot, snapshot.treeRoot);
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });

  describe('Claim', function() {
    const node = createNode();
    const orig = createNode();
    const comp = createNode();

    const {chain, miner, cpu} = node;

    const winner = node.wallet();
    const runnerup = node.wallet();

    let snapshot = null;

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(winner.getReceive());
      miner.addAddress(runnerup.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a claim', async () => {
      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });
});
