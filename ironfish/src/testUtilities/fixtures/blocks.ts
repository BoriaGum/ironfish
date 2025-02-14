/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Asset, generateKey, Note as NativeNote } from '@ironfish/rust-nodejs'
import { Assert } from '../../assert'
import { Blockchain } from '../../blockchain'
import { IronfishNode } from '../../node'
import { Block, BlockSerde, SerializedBlock } from '../../primitives/block'
import { BurnDescription } from '../../primitives/burnDescription'
import { MintDescription } from '../../primitives/mintDescription'
import { Note } from '../../primitives/note'
import { NoteEncrypted } from '../../primitives/noteEncrypted'
import { RawTransaction } from '../../primitives/rawTransaction'
import { Transaction } from '../../primitives/transaction'
import { Account, Wallet } from '../../wallet'
import { WorkerPool } from '../../workerPool/pool'
import { useAccountFixture } from './account'
import { FixtureGenerate, useFixture } from './fixture'
import {
  restoreTransactionFixtureToAccounts,
  usePostTxFixture,
  useTxFixture,
} from './transactions'
/*
 * We need the workaround because transactions related to us
 * that get added onto a block don't get handled in the same
 * way as if we created them, which is a problem. that's why
 * the transaction fixture uses accounts.createTransaction()
 * and not accountst.send(), so if its generated, and if its
 * cached, both have the same flow where we manually sync
 * them afterwards.
 */
export async function restoreBlockFixtureToAccounts(
  block: Block,
  wallet: Wallet,
): Promise<void> {
  for (const transaction of block.transactions) {
    await restoreTransactionFixtureToAccounts(transaction, wallet)
  }
}

/**
 * Executes a generator function which creates a block and
 * caches that in the fixtures folder next to the current test
 */
export async function useBlockFixture(
  chain: Blockchain,
  generate: FixtureGenerate<Block>,
  addTransactionsTo?: Wallet,
): Promise<Block> {
  return useFixture(generate, {
    process: async (block: Block): Promise<void> => {
      if (addTransactionsTo) {
        await restoreBlockFixtureToAccounts(block, addTransactionsTo)
      }
    },
    serialize: (block: Block): SerializedBlock => {
      return BlockSerde.serialize(block)
    },
    deserialize: (serialized: SerializedBlock): Block => {
      return BlockSerde.deserialize(serialized)
    },
  })
}

/**
 * Generates a block with a miners fee transaction on the current chain state
 */
export async function useMinerBlockFixture(
  chain: Blockchain,
  sequence?: number,
  account?: Account,
  addTransactionsTo?: Wallet,
  transactions: Transaction[] = [],
): Promise<Block> {
  const spendingKey = account ? account.spendingKey : generateKey().spending_key
  const transactionFees = transactions.reduce((a, t) => a + t.fee(), BigInt(0))

  return await useBlockFixture(
    chain,
    async () =>
      chain.newBlock(
        transactions,
        await chain.strategy.createMinersFee(
          transactionFees,
          sequence || chain.head.sequence + 1,
          spendingKey,
        ),
      ),
    addTransactionsTo,
  )
}

export async function useMintBlockFixture(options: {
  node: IronfishNode
  account: Account
  asset: Asset
  value: bigint
  sequence?: number
}): Promise<Block> {
  if (!options.sequence) {
    options.sequence = options.node.chain.head.sequence
  }

  const mint = await usePostTxFixture({
    node: options.node,
    wallet: options.node.wallet,
    from: options.account,
    mints: [{ asset: options.asset, value: options.value }],
  })

  return useMinerBlockFixture(options.node.chain, options.sequence, undefined, undefined, [
    mint,
  ])
}

export async function useBurnBlockFixture(options: {
  node: IronfishNode
  account: Account
  asset: Asset
  value: bigint
  sequence?: number
}): Promise<Block> {
  if (!options.sequence) {
    options.sequence = options.node.chain.head.sequence
  }

  const burn = await usePostTxFixture({
    node: options.node,
    wallet: options.node.wallet,
    from: options.account,
    burns: [{ assetId: options.asset.id(), value: options.value }],
  })

  return useMinerBlockFixture(options.node.chain, options.sequence, undefined, undefined, [
    burn,
  ])
}

export async function useBlockWithRawTxFixture(
  chain: Blockchain,
  pool: WorkerPool,
  sender: Account,
  notesToSpend: NoteEncrypted[],
  receives: { publicAddress: string; amount: bigint; memo: string; assetId: Buffer }[],
  mints: MintDescription[],
  burns: BurnDescription[],
  sequence: number,
): Promise<Block> {
  const generate = async () => {
    const spends = await Promise.all(
      notesToSpend.map(async (n) => {
        const note = n.decryptNoteForOwner(sender.incomingViewKey)
        Assert.isNotUndefined(note)
        const treeIndex = await chain.notes.leavesIndex.get(n.merkleHash())
        Assert.isNotUndefined(treeIndex)
        const witness = await chain.notes.witness(treeIndex)
        Assert.isNotNull(witness)

        return {
          note,
          witness,
        }
      }),
    )

    const raw = new RawTransaction()
    raw.spendingKey = sender.spendingKey
    raw.expiration = 0
    raw.mints = mints
    raw.burns = burns
    raw.fee = BigInt(0)
    raw.spends = spends

    for (const receive of receives) {
      const note = new NativeNote(
        receive.publicAddress,
        receive.amount,
        receive.memo,
        receive.assetId,
        sender.publicAddress,
      )

      raw.receives.push({ note: new Note(note.serialize()) })
    }

    const transaction = await pool.postTransaction(raw)

    return chain.newBlock(
      [transaction],
      await chain.strategy.createMinersFee(transaction.fee(), sequence, sender.spendingKey),
    )
  }

  return useBlockFixture(chain, generate)
}

/**
 * Produces a block with a transaction that has 1 spend, and 3 notes
 * By default first produces a block with a mining fee to fund the
 * {@link from} account and adds it to the chain.
 *
 * Returned block has 1 spend, 3 notes
 */
export async function useBlockWithTx(
  node: IronfishNode,
  from?: Account,
  to?: Account,
  useFee = true,
  options: {
    expiration?: number
    fee?: number
  } = { expiration: 0 },
): Promise<{ account: Account; previous: Block; block: Block; transaction: Transaction }> {
  if (!from) {
    from = await useAccountFixture(node.wallet, () => node.wallet.createAccount('test'))
  }

  if (!to) {
    to = from
  }

  let previous: Block
  if (useFee) {
    previous = await useMinerBlockFixture(node.chain, 2, from)
    await node.chain.addBlock(previous)
    await node.wallet.updateHead()
  } else {
    const head = await node.chain.getBlock(node.chain.head)
    Assert.isNotNull(head)
    previous = head
  }

  const block = await useBlockFixture(node.chain, async () => {
    Assert.isNotUndefined(from)
    Assert.isNotUndefined(to)

    const raw = await node.wallet.createTransaction(
      from,
      [
        {
          publicAddress: to.publicAddress,
          amount: BigInt(1),
          memo: '',
          assetId: Asset.nativeId(),
        },
      ],
      [],
      [],
      BigInt(options.fee ?? 1),
      0,
      options.expiration ?? 0,
    )

    const transaction = await node.wallet.postTransaction(raw, node.memPool)

    return node.chain.newBlock(
      [transaction],
      await node.strategy.createMinersFee(transaction.fee(), 3, generateKey().spending_key),
    )
  })

  return { block, previous, account: from, transaction: block.transactions[1] }
}

/**
 * Produces a block with a multiple transaction that have 1 spend, and 3 notes
 * It first produces {@link numTransactions} blocks all with mining fees to fund
 * the transactions
 *
 * Returned block has {@link numTransactions} transactions
 */
export async function useBlockWithTxs(
  node: IronfishNode,
  numTransactions: number,
  from?: Account,
): Promise<{ account: Account; block: Block; transactions: Transaction[] }> {
  if (!from) {
    from = await useAccountFixture(node.wallet, () => node.wallet.createAccount('test'))
  }
  const to = from

  let previous
  for (let i = 0; i < numTransactions; i++) {
    previous = await useMinerBlockFixture(node.chain, node.chain.head.sequence + 1, from)
    await node.chain.addBlock(previous)
  }

  await node.wallet.updateHead()

  const block = await useBlockFixture(node.chain, async () => {
    const transactions: Transaction[] = []
    for (let i = 0; i < numTransactions; i++) {
      Assert.isNotUndefined(from)

      const raw = await node.wallet.createTransaction(
        from,
        [
          {
            publicAddress: to.publicAddress,
            amount: BigInt(1),
            memo: '',
            assetId: Asset.nativeId(),
          },
        ],
        [],
        [],
        BigInt(1),
        0,
        0,
      )

      const transaction = await node.wallet.postTransaction(raw, node.memPool)

      await node.wallet.addPendingTransaction(transaction)
      transactions.push(transaction)
    }

    const transactionFees: bigint = transactions.reduce((sum, t) => {
      return BigInt(sum) + t.fee()
    }, BigInt(0))

    return node.chain.newBlock(
      transactions,
      await node.strategy.createMinersFee(transactionFees, 3, generateKey().spending_key),
    )
  })

  return { block, account: from, transactions: block.transactions.slice(1) }
}

export async function useTxSpendsFixture(
  node: IronfishNode,
  options?: {
    account?: Account
    expiration?: number
  },
): Promise<{ account: Account; transaction: Transaction }> {
  const account = options?.account ?? (await useAccountFixture(node.wallet))

  const block = await useMinerBlockFixture(node.chain, 2, account, node.wallet)

  await expect(node.chain).toAddBlock(block)
  await node.wallet.updateHead()

  const transaction = await useTxFixture(
    node.wallet,
    account,
    account,
    undefined,
    undefined,
    options?.expiration,
  )

  return {
    account: account,
    transaction: transaction,
  }
}
