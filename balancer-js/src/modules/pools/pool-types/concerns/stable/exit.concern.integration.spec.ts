import dotenv from 'dotenv';
import { expect } from 'chai';
import { Network, Pool, PoolModel, PoolToken, StaticPoolRepository } from '@/.';
import hardhat from 'hardhat';

import { TransactionReceipt } from '@ethersproject/providers';
import { BigNumber, parseFixed } from '@ethersproject/bignumber';
import { forkSetup, setupPool, getBalances } from '@/test/lib/utils';
import { PoolsProvider } from '@/modules/pools/provider';

import pools_14717479 from '@/test/lib/pools_14717479.json';
import { ExitPoolAttributes } from '../types';
import { networkAddresses } from '@/lib/constants/config';

dotenv.config();

const { ALCHEMY_URL: jsonRpcUrl } = process.env;
const { ethers } = hardhat;

const rpcUrl = 'http://127.0.0.1:8545';
const network = Network.MAINNET;
const provider = new ethers.providers.JsonRpcProvider(rpcUrl, network);
const signer = provider.getSigner();

const { tokens } = networkAddresses(network);

// Slots used to set the account balance for each token through hardhat_setStorageAt
// Info fetched using npm package slot20
const BPT_SLOT = 0;
const initialBalance = '100000';
const amountsOutDiv = (1e7).toString(); // FIXME: depending on this number, exitExactTokenOut (single token) throws Errors.STABLE_INVARIANT_DIDNT_CONVERGE
const slippage = '100';
const poolId =
  '0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063'; // Balancer USD Stable Pool - staBAL3

describe('exit execution', async () => {
  let tokensOut: PoolToken[];
  let amountsOut: string[];
  let transactionReceipt: TransactionReceipt;
  let bptBalanceBefore: BigNumber;
  let bptBalanceAfter: BigNumber;
  let bptMaxBalanceDecrease: BigNumber;
  let tokensBalanceBefore: BigNumber[];
  let tokensBalanceAfter: BigNumber[];
  let tokensMinBalanceIncrease: BigNumber[];
  let transactionCost: BigNumber;
  let signerAddress: string;
  let pool: PoolModel;

  // Setup chain
  before(async function () {
    this.timeout(20000);

    const sdkConfig = {
      network,
      rpcUrl,
    };
    // Using a static repository to make test consistent over time
    const poolsProvider = new PoolsProvider(
      sdkConfig,
      new StaticPoolRepository(pools_14717479 as Pool[])
    );
    pool = await setupPool(poolsProvider, poolId);
    tokensOut = pool.tokens;
    await forkSetup(
      signer,
      [pool.address],
      [BPT_SLOT],
      [parseFixed(initialBalance, 18).toString()],
      jsonRpcUrl as string,
      14717479 // holds the same state as the static repository
    );
    signerAddress = await signer.getAddress();
  });

  const testFlow = async (
    { to, data, maxBPTIn, minAmountsOut }: ExitPoolAttributes,
    exitTokens: string[],
    exitWithETH = false
  ) => {
    // Check balances before transaction to confirm success
    [bptBalanceBefore, ...tokensBalanceBefore] = await getBalances(
      [pool.address, ...exitTokens],
      signer,
      signerAddress
    );

    // Get expected balances out of transaction
    bptMaxBalanceDecrease = BigNumber.from(maxBPTIn);
    tokensMinBalanceIncrease = minAmountsOut.map((a) => BigNumber.from(a));

    // Send transaction to local fork
    const transactionResponse = await signer.sendTransaction({ to, data });
    transactionReceipt = await transactionResponse.wait();

    // Check balances after transaction to confirm success
    [bptBalanceAfter, ...tokensBalanceAfter] = await getBalances(
      [pool.address, ...exitTokens],
      signer,
      signerAddress
    );

    // add transaction cost to ETH balance when exiting with ETH
    if (exitWithETH) {
      transactionCost = transactionReceipt.gasUsed.mul(
        transactionReceipt.effectiveGasPrice
      );
      tokensBalanceAfter = tokensBalanceAfter.map((balance, i) => {
        if (pool.tokensList[i] === tokens.wrappedNativeAsset.toLowerCase()) {
          return balance.add(transactionCost);
        }
        return balance;
      });
    }
  };

  context('exitExactBPTIn', async () => {
    context('proportional amounts out', async () => {
      before(async function () {
        this.timeout(20000);
        const bptIn = parseFixed('10', 18).toString();
        await testFlow(
          pool.buildExitExactBPTIn(signerAddress, bptIn, slippage),
          pool.tokensList
        );
      });

      it('should work', async () => {
        expect(transactionReceipt.status).to.eql(1);
      });

      it('tokens balance should increase by at least minAmountsOut', async () => {
        for (let i = 0; i < tokensBalanceAfter.length; i++) {
          expect(
            tokensBalanceAfter[i]
              .sub(tokensBalanceBefore[i])
              .gte(tokensMinBalanceIncrease[i])
          ).to.be.true;
        }
      });

      it('bpt balance should decrease by exact bptMaxBalanceDecrease', async () => {
        expect(bptBalanceBefore.sub(bptBalanceAfter).eq(bptMaxBalanceDecrease))
          .to.be.true;
      });
    });
    context('single token max out', async () => {
      before(async function () {
        this.timeout(20000);
        const bptIn = parseFixed('10', 18).toString();
        await testFlow(
          pool.buildExitExactBPTIn(
            signerAddress,
            bptIn,
            slippage,
            false,
            pool.tokensList[0]
          ),
          pool.tokensList
        );
      });

      it('should work', async () => {
        expect(transactionReceipt.status).to.eql(1);
      });

      it('tokens balance should increase by at least minAmountsOut', async () => {
        for (let i = 0; i < tokensBalanceAfter.length; i++) {
          expect(
            tokensBalanceAfter[i]
              .sub(tokensBalanceBefore[i])
              .gte(tokensMinBalanceIncrease[i])
          ).to.be.true;
        }
      });

      it('bpt balance should decrease by exact bptMaxBalanceDecrease', async () => {
        expect(bptBalanceBefore.sub(bptBalanceAfter).eq(bptMaxBalanceDecrease))
          .to.be.true;
      });
    });
  });

  context('exitExactTokensOut', async () => {
    // FIXME: test scenario not working due to stable math issues with non-proportional inputs
    // Frontend currently does not support exiting with more than one exact token out

    // context('all tokens out', async () => {
    //   before(async function () {
    //     amountsOut = pool.tokens.map((t, i) =>
    //       parseFixed(t.balance, t.decimals)
    //         .div(amountsOutDiv)
    //         .mul(i + 1)
    //         .toString()
    //     );

    //     await testFlow(
    //       pool.buildExitExactTokensOut(
    //         signerAddress,
    //         tokensOut.map((t) => t.address),
    //         amountsOut,
    //         slippage
    //       ),
    //       pool.tokensList
    //     );
    //   });

    //   it('should work', async () => {
    //     expect(transactionReceipt.status).to.eql(1);
    //   });

    //   it('tokens balance should increase by exact amountsOut', async () => {
    //     for (let i = 0; i < tokensBalanceAfter.length; i++) {
    //       expect(
    //         tokensBalanceAfter[i]
    //           .sub(tokensBalanceBefore[i])
    //           .eq(tokensMinBalanceIncrease[i])
    //       ).to.be.true;
    //     }
    //   });

    //   it('bpt balance should decrease by max bptMaxBalanceDecrease', async () => {
    //     expect(bptBalanceBefore.sub(bptBalanceAfter).lte(bptMaxBalanceDecrease))
    //       .to.be.true;
    //   });
    // });

    context('single token out', async () => {
      before(async function () {
        amountsOut = pool.tokens.map((t, i) => {
          if (i === 0) {
            return parseFixed(t.balance, t.decimals)
              .div(amountsOutDiv)
              .toString();
          }
          return '0';
        });

        await testFlow(
          pool.buildExitExactTokensOut(
            signerAddress,
            tokensOut.map((t) => t.address),
            amountsOut,
            slippage
          ),
          pool.tokensList
        );
      });

      it('should work', async () => {
        expect(transactionReceipt.status).to.eql(1);
      });

      it('tokens balance should increase by exact amountsOut', async () => {
        for (let i = 0; i < tokensBalanceAfter.length; i++) {
          expect(
            tokensBalanceAfter[i]
              .sub(tokensBalanceBefore[i])
              .eq(tokensMinBalanceIncrease[i])
          ).to.be.true;
        }
      });

      it('bpt balance should decrease by max bptMaxBalanceDecrease', async () => {
        expect(bptBalanceBefore.sub(bptBalanceAfter).lte(bptMaxBalanceDecrease))
          .to.be.true;
      });
    });
  });
}).timeout(20000);
