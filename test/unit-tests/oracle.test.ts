import {
  MockPricerInstance,
  MockAddressBookInstance,
  OracleInstance,
  MockOtokenInstance,
  MockERC20Instance,
} from '../../build/types/truffle-types'
import BigNumber from 'bignumber.js'
import {assert} from 'chai'
import {createTokenAmount} from '../utils'

const {expectRevert, expectEvent, time} = require('@openzeppelin/test-helpers')

const MockPricer = artifacts.require('MockPricer.sol')
const MockAddressBook = artifacts.require('MockAddressBook.sol')
const MockERC20 = artifacts.require('MockERC20.sol')
const Otoken = artifacts.require('MockOtoken.sol')
const Oracle = artifacts.require('Oracle.sol')

// address(0)
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

contract('Oracle', ([owner, disputer, random, collateral, strike]) => {
  // const batch = web3.utils.asciiToHex('ETHUSDCUSDC1596218762')
  // mock a pricer
  let wethPricer: MockPricerInstance
  // AddressBook module
  let addressBook: MockAddressBookInstance
  // Oracle module
  let oracle: OracleInstance
  // otoken
  let otoken: MockOtokenInstance
  let weth: MockERC20Instance
  let otokenExpiry: BigNumber

  before('Deployment', async () => {
    // addressbook module
    addressBook = await MockAddressBook.new({from: owner})
    // deploy Oracle module
    oracle = await Oracle.new({from: owner})

    // mock tokens
    weth = await MockERC20.new('WETH', 'WETH', 18)
    otoken = await Otoken.new()
    otokenExpiry = new BigNumber((await time.latest()).toNumber() + time.duration.days(30).toNumber())
    await otoken.init(addressBook.address, weth.address, strike, collateral, '200', otokenExpiry, true)

    // deply mock pricer (to get live price and set expiry price)
    wethPricer = await MockPricer.new(weth.address, oracle.address)
  })

  describe('Set asset pricer', () => {
    it('should revert setting pricer from non-owner address', async () => {
      await expectRevert(
        oracle.setAssetPricer(weth.address, wethPricer.address, {from: random}),
        'Ownable: caller is not the owner',
      )
    })

    it('should revert setting pricer to address(0)', async () => {
      await expectRevert(
        oracle.setAssetPricer(weth.address, ZERO_ADDR, {from: owner}),
        'Oracle: cannot set pricer to address(0)',
      )
    })

    it('should set asset pricer', async () => {
      await oracle.setAssetPricer(weth.address, wethPricer.address, {from: owner})

      assert.equal(await oracle.getPricer(weth.address), wethPricer.address, 'batch oracle address mismatch')
    })
  })

  describe('Get live price.', () => {
    it("should when querying assets that doesn't have pricer yet.", async () => {
      await expectRevert(oracle.getPrice(random), 'Oracle: Pricer for this asset not set')
    })

    it('should get the same price as Pricer', async () => {
      const pricerPrice = await wethPricer.getPrice()
      const oraclePrice = await oracle.getPrice(weth.address)
      assert.equal(pricerPrice.toString(), oraclePrice.toString())
    })

    it('should update after Pricer update', async () => {
      const price1 = createTokenAmount(235)
      await wethPricer.setPrice(price1)
      const oraclePrice = await oracle.getPrice(weth.address)
      assert.equal(oraclePrice.toString(), price1)
    })
  })

  describe('Oracle locking period', () => {
    const lockingPeriod = new BigNumber(60 * 15) // 15min

    it('should revert setting pricer locking period from non-owner address', async () => {
      await expectRevert(
        oracle.setLockingPeriod(wethPricer.address, lockingPeriod, {from: random}),
        'Ownable: caller is not the owner',
      )
    })

    it('should set pricer locking period', async () => {
      await oracle.setLockingPeriod(wethPricer.address, lockingPeriod, {from: owner})

      assert.equal(
        (await oracle.getPricerLockingPeriod(wethPricer.address)).toString(),
        lockingPeriod.toString(),
        'oracle locking period mismatch',
      )
    })

    it('should check if locking period is over', async () => {
      const isOver = await oracle.isLockingPeriodOver(wethPricer.address, await time.latest(), {from: owner})
      const expectedResult = false
      assert.equal(isOver, expectedResult, 'locking period check mismatch')
    })
  })

  describe('Pricer dispute period', () => {
    const disputePeriod = new BigNumber(60 * 45) // 45min

    it('should revert setting pricer locking period from non-owner address', async () => {
      await expectRevert(
        oracle.setDisputePeriod(wethPricer.address, disputePeriod, {from: random}),
        'Ownable: caller is not the owner',
      )
    })

    it('should set oracle dispute period', async () => {
      await oracle.setDisputePeriod(wethPricer.address, disputePeriod, {from: owner})

      assert.equal(
        (await oracle.getPricerDisputePeriod(wethPricer.address)).toString(),
        disputePeriod.toString(),
        'oracle dispute period mismatch',
      )
    })

    it('should check if dispute period is over when no price submitted for that timestamp', async () => {
      const isOver = await oracle.isDisputePeriodOver(weth.address, await time.latest(), {from: owner})
      const expectedResult = false
      assert.equal(isOver, expectedResult, 'dispute period check mismatch')
    })
  })

  describe('Set Expiry Price', () => {
    let assetPrice: BigNumber

    before(async () => {
      await time.increaseTo(otokenExpiry.toNumber())
      assetPrice = new BigNumber(278)
    })

    it('should revert setting price if caller is not the pricer or disputer', async () => {
      // increase til locking period over
      await expectRevert(
        oracle.setExpiryPrice(weth.address, otokenExpiry, assetPrice, {from: random}),
        'Oracle: caller is not authorized to set expiry price',
      )
    })

    it('should revert setting price if locking period is not over', async () => {
      // the setExpiryPrice is set through pricer
      await expectRevert(
        wethPricer.setExpiryPriceInOracle(otokenExpiry, assetPrice),
        'Oracle: locking period is not over yet',
      )
    })

    it('should end locking period', async () => {
      const lockingPeriod = (await oracle.getPricerLockingPeriod(wethPricer.address)).toNumber()
      await time.increase(lockingPeriod + 100)
      const isLockingPeriodOver = await oracle.isLockingPeriodOver(weth.address, otokenExpiry)
      assert.equal(isLockingPeriodOver, true)
    })

    it('should set price correctly', async () => {
      // setExpiryPrice is called through pricer
      await wethPricer.setExpiryPriceInOracle(otokenExpiry, assetPrice)

      const [price, isFinalized] = await oracle.getExpiryPrice(weth.address, otokenExpiry)
      assert.equal(price.toString(), assetPrice.toString())
      assert.equal(isFinalized, false)
    })

    it('should revert if the same asset - expiry is set twice', async () => {
      await expectRevert(wethPricer.setExpiryPriceInOracle(otokenExpiry, assetPrice), 'Oracle: dispute period started')
    })
  })

  describe('Set disputer', () => {
    it('should return address(0) for disputer', async () => {
      const disputer = await oracle.getDisputer()
      assert.equal(disputer, ZERO_ADDR)
    })

    it('should revert setting disputer from a non-owner address', async () => {
      await expectRevert(oracle.setDisputer(disputer, {from: random}), 'Ownable: caller is not the owner')
    })

    it('should set the disputer from the owner', async () => {
      expectEvent(await oracle.setDisputer(disputer, {from: owner}), 'DisputerUpdated', {newDisputer: disputer})
      assert.equal(await oracle.getDisputer(), disputer)
    })
  })

  describe('Dispute price', () => {
    const disputePrice = new BigNumber(700)

    it('should revert before setting any disputer', async () => {
      await expectRevert(
        oracle.disputeExpiryPrice(weth.address, otokenExpiry, disputePrice, {from: random}),
        'Oracle: caller is not the disputer',
      )
    })

    it('should revert disputing price during dispute period from non-disputer', async () => {
      await expectRevert(
        oracle.disputeExpiryPrice(weth.address, otokenExpiry, disputePrice, {from: random}),
        'Oracle: caller is not the disputer',
      )
    })

    it('should dispute price during dispute period', async () => {
      await oracle.disputeExpiryPrice(weth.address, otokenExpiry, disputePrice, {from: disputer})

      const price = await oracle.getExpiryPrice(weth.address, otokenExpiry)
      assert.equal(price[0].toString(), disputePrice.toString(), 'asset price mismatch')
    })

    it('should revert disputing price after dispute period over', async () => {
      const disputePeriod = (await oracle.getPricerDisputePeriod(wethPricer.address)).toNumber()
      await time.increase(disputePeriod + 100)

      await expectRevert(
        oracle.disputeExpiryPrice(weth.address, otokenExpiry, disputePrice, {from: disputer}),
        'Oracle: dispute period over',
      )
    })
  })

  describe('Set Expiry Price From Disputer', async () => {
    const lockingPeriod = new BigNumber(60 * 15) // 15min
    const disputePeriod = new BigNumber(60 * 45) // 45min
    const assetPrice = new BigNumber(278)

    let otoken: MockOtokenInstance
    let otokenExpiry: BigNumber

    before(async () => {
      otoken = await Otoken.new()
      otokenExpiry = new BigNumber((await time.latest()).toNumber() + time.duration.days(30).toNumber())
      await otoken.init(addressBook.address, weth.address, strike, collateral, '200', otokenExpiry, true)
      await oracle.setAssetPricer(weth.address, wethPricer.address, {from: owner})
      await oracle.setLockingPeriod(wethPricer.address, lockingPeriod, {from: owner})
      await oracle.setDisputePeriod(wethPricer.address, disputePeriod, {from: owner})

      await time.increaseTo(otokenExpiry.toNumber())
      await time.increase(lockingPeriod.toNumber() + 100)

      // set disputer address
      await oracle.setDisputer(disputer, {from: owner})
    })

    it('should set price correctly from disputer', async () => {
      // setExpiryPrice is called from disputer
      await oracle.setExpiryPrice(weth.address, otokenExpiry, assetPrice, {from: disputer})

      const [price, isFinalized] = await oracle.getExpiryPrice(weth.address, otokenExpiry)
      assert.equal(price.toString(), assetPrice.toString())
      assert.equal(isFinalized, false)
    })
  })
})
