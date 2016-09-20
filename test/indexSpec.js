'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const sinon = require('sinon')
const wsHelper = require('./helpers/ws')
const errors = require('../src/errors')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('PluginBells', function () {
  afterEach(function () { assert(nock.isDone(), 'nock was not called') })

  it('should be a class', function () {
    assert.isFunction(PluginBells)
  })

  describe('constructor', function () {
    it('should succeed with valid configuration', function () {
      const plugin = new PluginBells({
        prefix: 'foo.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })

      assert.instanceOf(plugin, PluginBells)
    })

    it('should throw when options are missing', function () {
      assert.throws(() => {
        return new PluginBells()
      }, 'Expected an options object, received: undefined')
    })

    it('should throw when options.prefix is missing', function () {
      assert.throws(() => {
        return new PluginBells({
          prefix: 5 // prefix is wrong type
        })
      }, 'Expected options.prefix to be a string, received: number')
    })

    it('should throw when options.prefix is an invalid prefix', function () {
      assert.throws(() => {
        return new PluginBells({
          prefix: 'foo', // no trailing "."
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        })
      }, 'Expected options.prefix to end with "."')
    })
  })

  describe('instance', function () {
    beforeEach(function * () {
      this.plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })

      this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
    })

    describe('connect', function () {
      it('connects', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)

        yield assertResolve(this.plugin.connect(), null)
        assert.isTrue(this.plugin.isConnected())
      })

      it('ignores if called twice', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })

        const nockInfo = nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)

        yield this.plugin.connect()
        yield this.plugin.connect()
        assert.isTrue(this.plugin.isConnected())
        nockInfo.done()
      })

      it('fails if the response is invalid', function (done) {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, { name: 'mike' })

        this.plugin.connect().should.be
          .rejectedWith('Failed to resolve ledger URI from account URI')
          .notify(() => {
            assert.isFalse(this.plugin.isConnected())
            done()
          })
      })

      it('should set the username based on the account name returned', function * () {
        const accountNock = nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        const infoNock = nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)
        yield this.plugin.connect()
        assert.equal(this.plugin.credentials.username, 'mike')
        accountNock.done()
        infoNock.done()
      })

      it('should not overwrite the username if one is specified in the options', function * () {
        const accountNock = nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        const infoNock = nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)
        const plugin = new PluginBells({
          prefix: 'foo.',
          account: 'http://red.example/accounts/mike',
          password: 'mike',
          username: 'xavier'
        })
        yield plugin.connect()
        assert.equal(plugin.credentials.username, 'xavier')
        accountNock.done()
        infoNock.done()
      })

      it('doesn\'t retry if account is nonexistant', function (done) {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(404)

        this.plugin.connect().should.be
          .rejectedWith('Failed to resolve ledger URI from account URI')
          .notify(() => {
            assert.isFalse(this.plugin.isConnected())
            done()
          })
      })

      describe('a connector', function () {
        beforeEach(function () {
          this.plugin = new PluginBells({
            connector: 'http://mark.example',
            prefix: 'example.red.',
            account: 'http://red.example/accounts/mike',
            password: 'mike'
          })
        })

        it('sets the connector field', function * () {
          nock('http://red.example')
            .get('/accounts/mike')
            .reply(200, { ledger: 'http://red.example', name: 'mike' })
            .put('/accounts/mike', { name: 'mike', connector: 'http://mark.example' })
            .reply(200)

          const nockInfo = nock('http://red.example')
            .get('/')
            .reply(200, this.infoRedLedger)

          yield this.plugin.connect()

          nockInfo.done()
        })

        it('throws an ExternalError if unable to set the connector field', function (done) {
          nock('http://red.example')
            .get('/accounts/mike')
            .reply(200, { ledger: 'http://red.example', name: 'mike' })
            .put('/accounts/mike', { name: 'mike', connector: 'http://mark.example' })
            .reply(500)
          this.plugin.connect().should.be
            .rejectedWith('Remote error: status=500')
            .notify(done)
        })
      })
    })

    describe('getAccount (not connected)', function () {
      it('throws if not connected', function (done) {
        this.plugin.getAccount().catch(function (err) {
          assert.equal(err.message, 'Must be connected before getAccount can be called')
          done()
        })
      })
    })
  })

  describe('connected instance', function () {
    beforeEach(function * () {
      this.plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })

      this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      const nockAccount = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })

      const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, infoRedLedger)

      this.wsRedLedger = new wsHelper.Server('ws://red.example/accounts/mike/transfers')

      yield this.plugin.connect()

      nockAccount.done()
      nockInfo.done()
    })

    afterEach(function * () {
      this.wsRedLedger.stop()
    })

    function * itEmitsFulfillExecutionCondition () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferExecuted, {
          execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }),
        related_resources: {
          execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubPrepare) sinon.assert.notCalled(this.stubPrepare)
      sinon.assert.calledOnce(this.stubFulfillExecutionCondition)
      sinon.assert.calledWith(this.stubFulfillExecutionCondition,
        Object.assign(this.transfer, {
          executionCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }), 'cf:0:ZXhlY3V0ZQ')
    }

    function * itEmitsFulfillCancellationCondition () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferExecuted, {
          state: 'rejected',
          cancellation_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }),
        related_resources: {
          cancellation_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      sinon.assert.calledOnce(this.stubFulfillCancellationCondition)
      sinon.assert.calledWith(this.stubFulfillCancellationCondition,
        Object.assign(this.transfer, {
          cancellationCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }), 'cf:0:ZXhlY3V0ZQ')
    }

    describe('notifications of unrelated transfers', function () {
      it('emits an UnrelatedNotificationError for an unrelated notification', function (done) {
        this.wsRedLedger.on('message', function (message) {
          assert.deepEqual(JSON.parse(message), {
            result: 'ignored',
            ignoreReason: {
              id: 'UnrelatedNotificationError',
              message: 'Notification does not seem related to connector'
            }
          })
          done()
        })
        this.wsRedLedger.send(JSON.stringify({
          resource: {
            id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/alice',
              amount: '10'
            }],
            credits: [{
              account: 'http://red.example/accounts/bob',
              amount: '10'
            }],
            state: 'executed'
          }
        }))
      })
    })

    describe('notification of timeout', function () {
      beforeEach(function () {
        this.stubReceive = sinon.stub()
        this.stubFulfillExecutionCondition = sinon.stub()
        this.stubIncomingCancel = sinon.stub()
        this.stubOutgoingCancel = sinon.stub()
        this.plugin.on('incoming_cancel', this.stubIncomingCancel)
        this.plugin.on('outgoing_cancel', this.stubOutgoingCancel)
        this.plugin.on('incoming_prepare', this.stubReceive)
        this.plugin.on('outgoing_fulfill', this.stubFulfillExecutionCondition)

        this.fiveBellsTransferMike = {
          id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/alice',
            amount: '10'
          }],
          credits: [{
            account: 'http://red.example/accounts/mike',
            amount: '10'
          }],
          state: 'rejected'
        }
        this.fiveBellsTransferAlice = {
          id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/mike',
            amount: '10'
          }],
          credits: [{
            account: 'http://red.example/accounts/alice',
            amount: '10'
          }],
          state: 'rejected'
        }

        this.transfer = {
          id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          direction: 'incoming',
          account: 'example.red.alice',
          amount: '10',
          expiresAt: (new Date((new Date()).getTime() + 1000)).toISOString()
        }
      })

      it('should handle a rejected transfer to mike', function * () {
        this.wsRedLedger.send(JSON.stringify({
          resource: Object.assign(this.fiveBellsTransferAlice, {
            execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
          }),
          related_resources: {
            execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
          }
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

        if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
        sinon.assert.calledOnce(this.stubOutgoingCancel)
        sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      })

      it('should handle a rejected transfer to alice', function * () {
        this.wsRedLedger.send(JSON.stringify({
          resource: Object.assign(this.fiveBellsTransferMike, {
            execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
          }),
          related_resources: {
            execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
          }
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

        if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
        sinon.assert.calledOnce(this.stubIncomingCancel)
        sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      })
    })

    describe('notifications of incoming transfers', function () {
      beforeEach(function () {
        this.stubPrepare = sinon.stub()
        this.stubExecute = sinon.stub()
        this.stubReject = sinon.stub()
        this.stubFulfillExecutionCondition = sinon.stub()
        this.stubFulfillCancellationCondition = sinon.stub()
        this.plugin.on('incoming_prepare', this.stubPrepare)
        this.plugin.on('incoming_transfer', this.stubExecute)
        this.plugin.on('incoming_reject', this.stubReject)
        this.plugin.on('incoming_fulfill', this.stubFulfillExecutionCondition)
        this.plugin.on('incoming_cancel', this.stubFulfillCancellationCondition)

        this.fiveBellsTransferExecuted = {
          id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/alice',
            amount: '10'
          }],
          credits: [{
            account: 'http://red.example/accounts/mike',
            amount: '10'
          }],
          state: 'executed'
        }
        this.transfer = {
          id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          direction: 'incoming',
          account: 'example.red.alice',
          ledger: 'example.red.',
          amount: '10'
        }
      })

      it('should emit "incoming_fulfill" on incoming executed transfers',
        itEmitsFulfillExecutionCondition)
      it('should emit "incoming_cancel" on incoming rejected transfers',
        itEmitsFulfillCancellationCondition)

      it('should emit "incoming_reject" with the rejection_message', function * () {
        this.wsRedLedger.send(JSON.stringify({
          resource: Object.assign(this.fiveBellsTransferExecuted, {
            state: 'rejected',
            credits: [
              Object.assign(this.fiveBellsTransferExecuted.credits[0], {
                rejected: true,
                rejection_message: new Buffer('fail!').toString('base64')
              })
            ]
          })
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

        if (this.stubPrepare) sinon.assert.notCalled(this.stubPrepare)
        sinon.assert.notCalled(this.stubFulfillExecutionCondition)
        sinon.assert.notCalled(this.stubFulfillCancellationCondition)
        sinon.assert.calledOnce(this.stubReject)
        sinon.assert.calledWith(this.stubReject, this.transfer, 'fail!')
      })

      it('should pass on incoming prepared transfers', function * () {
        this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
        this.fiveBellsTransferExecuted.state = 'prepared'
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubPrepare)
        sinon.assert.calledWith(this.stubPrepare, Object.assign(this.transfer, {
          expiresAt: this.fiveBellsTransferExecuted.expires_at
        }))
      })

      it('should pass on incoming executed transfers', function * () {
        this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubExecute)
        sinon.assert.calledWith(this.stubExecute, Object.assign(this.transfer, {
          expiresAt: this.fiveBellsTransferExecuted.expires_at
        }))
      })

      it('should ignore unrelated credits', function * () {
        this.fiveBellsTransferExecuted.credits.push({
          account: 'http://red.example/accounts/george',
          amount: '10'
        })
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubExecute)
        sinon.assert.calledWith(this.stubExecute, this.transfer)
      })
    })

    describe('notifications of outgoing transfers', function () {
      beforeEach(function () {
        this.stubFulfillExecutionCondition = sinon.stub()
        this.stubFulfillCancellationCondition = sinon.stub()
        this.stubOutgoingPrepare = sinon.stub()
        this.stubOutgoingExecute = sinon.stub()
        this.stubOutgoingReject = sinon.stub()
        this.plugin.on('outgoing_prepare', this.stubOutgoingPrepare)
        this.plugin.on('outgoing_transfer', this.stubOutgoingExecute)
        this.plugin.on('outgoing_fulfill', this.stubFulfillExecutionCondition)
        this.plugin.on('outgoing_cancel', this.stubFulfillCancellationCondition)
        this.plugin.on('outgoing_reject', this.stubOutgoingReject)

        this.fiveBellsTransferExecuted = {
          id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/mike',
            amount: '10'
          }],
          credits: [{
            account: 'http://red.example/accounts/alice',
            amount: '10'
          }],
          state: 'executed'
        }
        this.transfer = {
          id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          direction: 'outgoing',
          account: 'example.red.alice',
          ledger: 'example.red.',
          amount: '10'
        }
      })

      it('should emit "outgoing_fulfill" on outgoing executed transfers',
        itEmitsFulfillExecutionCondition)
      it('should emit "outgoing_cancel" on outgoing rejected transfers',
        itEmitsFulfillCancellationCondition)

      it('should emit outgoing_cancel with the rejection_message', function * () {
        this.wsRedLedger.send(JSON.stringify({
          resource: Object.assign(this.fiveBellsTransferExecuted, {
            state: 'rejected',
            credits: [
              Object.assign(this.fiveBellsTransferExecuted.credits[0], {
                rejected: true,
                rejection_message: new Buffer('fail!').toString('base64')
              })
            ]
          })
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

        if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
        sinon.assert.notCalled(this.stubFulfillExecutionCondition)
        sinon.assert.notCalled(this.stubFulfillCancellationCondition)
        sinon.assert.calledOnce(this.stubOutgoingReject)
        sinon.assert.calledWith(this.stubOutgoingReject, this.transfer, 'fail!')
      })

      it('be notified of an outgoing prepare', function * () {
        this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
        this.fiveBellsTransferExecuted.state = 'prepared'
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubOutgoingPrepare)
        sinon.assert.calledWith(this.stubOutgoingPrepare, Object.assign(this.transfer, {
          expiresAt: this.fiveBellsTransferExecuted.expires_at
        }))
      })

      it('be notified of an outgoing execute', function * () {
        this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubOutgoingExecute)
        sinon.assert.calledWith(this.stubOutgoingExecute, Object.assign(this.transfer, {
          expiresAt: this.fiveBellsTransferExecuted.expires_at
        }))
      })
    })

    describe('disconnect', function () {
      it('closes the connection', function * () {
        assert.isTrue(this.plugin.isConnected())
        yield assertResolve(this.plugin.disconnect(), null)
        assert.isFalse(this.plugin.isConnected())
        // A second time does nothing.
        yield assertResolve(this.plugin.disconnect(), null)
      })
    })

    describe('getInfo', function () {
      it('gets the precision and scale', function * () {
        nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)
        const info = {
          connectors: [{
            id: 'http://red.example/accounts/mark',
            name: 'mark',
            connector: 'http://connector.example'
          }],
          currencyCode: 'USD',
          currencySymbol: '$',
          precision: 2,
          scale: 4
        }
        yield assertResolve(this.plugin.getInfo(), info)
        // The result is cached.
        yield assertResolve(this.plugin.getInfo(), info)
      })

      it('throws an ExternalError on 500', function (done) {
        nock('http://red.example')
          .get('/')
          .reply(500)
        this.plugin.getInfo().should.be
          .rejectedWith('Unable to determine ledger precision')
          .notify(done)
      })

      it('throws an ExternalError when the precision is missing', function (done) {
        nock('http://red.example')
          .get('/')
          .reply(200, {scale: 4})
        this.plugin.getInfo().should.be
          .rejectedWith('Unable to determine ledger precision')
          .notify(done)
      })
    })

    describe('getPrefix', function () {
      it('returns the plugin\'s prefix', function * () {
        yield assertResolve(this.plugin.getPrefix(), 'example.red.')
      })

      it('fails without any prefix', function (done) {
        const plugin = new PluginBells({
          // no prefix
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        })
        plugin.getPrefix().should.be
          .rejectedWith('Prefix has not been set')
          .notify(done)
      })

      it('cannot connect without any prefix', function (done) {
        const plugin = new PluginBells({
          account: 'http://blue.example/accounts/mike',
          password: 'mike',
          debugReplyNotifications: true,
          debugAutofund: {
            connector: 'http://mark.example',
            admin: {username: 'adminuser', password: 'adminpass'}
          }
        })

        const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
        const nockInfo = nock('http://blue.example')
          .get('/')
          .reply(200, infoRedLedger)

        const nockAccount = nock('http://blue.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://blue.example',
            name: 'mike'
          })

        plugin.connect().should.be
          .rejectedWith('Unable to set prefix from ledger or from local config')
          .notify(() => {
            nockInfo.done()
            nockAccount.done()
            done()
          })
      })

      it('should use local if ledger and local prefix don\'t match', function (done) {
        const plugin = new PluginBells({
          prefix: 'example.red.',
          account: 'http://blue.example/accounts/mike',
          password: 'mike',
          debugReplyNotifications: true,
          debugAutofund: {
            connector: 'http://mark.example',
            admin: {username: 'adminuser', password: 'adminpass'}
          }
        })

        const infoRedLedger = Object.assign(
          cloneDeep(require('./data/infoRedLedger.json')),
          { ilp_prefix: 'example.blue.' }
        )
        const nockInfo = nock('http://blue.example')
          .get('/')
          .reply(200, infoRedLedger)

        const nockAccount = nock('http://blue.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://blue.example',
            name: 'mike'
          })

        plugin.connect().then(() => {
          assert.equal(plugin.prefix, 'example.red.')
          nockInfo.done()
          nockAccount.done()
          done()
        })
      })

      it('gets the ledger\'s prefix when available', function * () {
        const plugin = new PluginBells({
          // no prefix
          account: 'http://blue.example/accounts/mike',
          password: 'mike',
          debugReplyNotifications: true,
          debugAutofund: {
            connector: 'http://mark.example',
            admin: {username: 'adminuser', password: 'adminpass'}
          }
        })

        const infoRedLedger = Object.assign(
          cloneDeep(require('./data/infoRedLedger.json')),
          { ilp_prefix: 'example.blue.' }
        )
        const nockInfo = nock('http://blue.example')
          .get('/')
          .reply(200, infoRedLedger)

        const nockAccount = nock('http://blue.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://blue.example',
            name: 'mike'
          })

        this.wsRedLedger = new wsHelper.Server('ws://blue.example/accounts/mike/transfers')

        yield plugin.connect()
        yield assertResolve(plugin.getPrefix(), 'example.blue.')
        yield plugin.disconnect()
        nockInfo.done()
        nockAccount.done()
      })
    })

    describe('getAccount', function () {
      it('returns the plugin\'s account', function * () {
        yield assertResolve(this.plugin.getAccount(), 'example.red.mike')
      })

      it('fails without any prefix', function (done) {
        const plugin = new PluginBells({
          // no prefix
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        })
        plugin.getAccount().should.be
          .rejectedWith('Must be connected before getAccount can be called')
          .notify(done)
      })
    })

    describe('getBalance', function () {
      it('returns the current balance', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(200, {balance: '100'})
        yield assertResolve(this.plugin.getBalance(), '100')
      })

      it('throws an ExternalError on 500', function (done) {
        nock('http://red.example')
          .get('/accounts/mike')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(500)
        this.plugin.getBalance().should.be
          .rejectedWith('Unable to determine current balance')
          .notify(done)
      })
    })

    describe('send', function () {
      it('submits a transfer', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
            id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/mike',
              amount: '123',
              authorized: true,
              memo: {source: 'something'}
            }],
            credits: [{
              account: 'http://red.example/accounts/alice',
              amount: '123',
              memo: {foo: 'bar'}
            }]
          })
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(200)
        yield assertResolve(this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '123',
          noteToSelf: {source: 'something'},
          data: {foo: 'bar'}
        }), null)
      })

      it('throws InvalidFieldsError for missing account', function (done) {
        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          amount: '1'
        }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid account').notify(done)
      })

      it('throws InvalidFieldsError for missing amount', function (done) {
        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice'
        }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid amount').notify(done)
      })

      it('throws InvalidFieldsError for negative amount', function (done) {
        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '-1'
        }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid amount').notify(done)
      })

      it('rejects a transfer when the destination does not begin with the correct prefix', function * () {
        yield assert.isRejected(this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'red.alice',
          amount: '123',
          noteToSelf: {source: 'something'},
          data: {foo: 'bar'}
        }), /^Error: Destination address "red.alice" must start with ledger prefix "example.red."$/)
      })

      it('throws an InvalidFieldsError on InvalidBodyError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(400, {id: 'InvalidBodyError', message: 'fail'})

        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '123'
        }).should.be.rejectedWith(errors.InvalidFieldsError, 'fail').notify(done)
      })

      it('throws a DuplicateIdError on InvalidModificationError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(400, {id: 'InvalidModificationError', message: 'fail'})

        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '123'
        }).should.be.rejectedWith(errors.DuplicateIdError, 'fail').notify(done)
      })

      it('throws an NotAcceptedError on 400', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
            id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/mike',
              amount: '123',
              authorized: true
            }],
            credits: [{
              account: 'http://red.example/accounts/alice',
              amount: '123'
            }]
          })
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(400, {id: 'SomeError', message: 'fail'})

        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '123'
        }).should.be.rejectedWith(errors.NotAcceptedError, 'fail').notify(done)
      })

      it('sets up case notifications when "cases" is provided', function * () {
        nock('http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086')
          .post('/targets', ['http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment'])
          .reply(200)
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
            id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/mike',
              amount: '123',
              authorized: true
            }],
            credits: [{
              account: 'http://red.example/accounts/alice',
              amount: '123'
            }],
            additional_info: {cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']}
          })
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(200)

        yield this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '123',
          cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
        })
      })

      it('handles unexpected status on cases notification', function (done) {
        nock('http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086')
          .post('/targets', ['http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment'])
          .reply(400)

        this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'example.red.alice',
          amount: '123',
          cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
        }).should.be.rejectedWith('Unexpected status code: 400').notify(done)
      })
    })

    describe('fulfillCondition', function () {
      it('throws InvalidFieldsError on InvalidBodyError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(422, {id: 'InvalidBodyError', message: 'fail'})
        this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
          .should.be.rejectedWith(errors.InvalidFieldsError, 'fail')
          .notify(done)
      })

      it('throws NotAcceptedError on UnmetConditionError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(422, {id: 'UnmetConditionError', message: 'fail'})
        this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
          .should.be.rejectedWith(errors.NotAcceptedError, 'fail')
          .notify(done)
      })

      it('throws TransferNotConditionalError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(422, {id: 'TransferNotConditionalError', message: 'fail'})
        this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
          .should.be.rejectedWith(errors.TransferNotConditionalError, 'fail')
          .notify(done)
      })

      it('throws TransferNotFoundError on NotFoundError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(404, {id: 'NotFoundError', message: 'fail'})
        this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
          .should.be.rejectedWith(errors.TransferNotFoundError, 'fail')
          .notify(done)
      })

      it('throws AlreadyRolledBackError when fulfilling a rejected transfer', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(404, {
            id: 'InvalidModificationError',
            message: 'Transfers in state rejected may not be executed'
          })
        this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
          .should.be.rejectedWith(errors.AlreadyRolledBackError, 'Transfers in state rejected may not be executed')
          .notify(done)
      })

      it('puts the fulfillment', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(201)
        yield assertResolve(this.plugin.fulfillCondition(
          '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          'cf:0:ZXhlY3V0ZQ'), null)
      })

      it('throws an ExternalError on 500', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(500)
        this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:ZXhlY3V0ZQ')
          .should.be.rejectedWith('Failed to submit fulfillment for' +
            ' transfer: 6851929f-5a91-4d02-b9f4-4ae6b7f1768c' +
            ' Error: undefined')
          .notify(done)
      })
    })

    describe('getFulfillment', function () {
      it('returns the fulfillment', function * () {
        nock('http://red.example')
          .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(200, 'cf:0:ZXhlY3V0ZQ')
        yield assertResolve(
          this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'),
          'cf:0:ZXhlY3V0ZQ')
      })

      it('throws TransferNotFoundError', function * () {
        nock('http://red.example')
          .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(404, {
            id: 'TransferNotFoundError',
            message: 'This transfer does not exist'
          })
        try {
          yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        } catch (err) {
          assert.equal(err.name, 'TransferNotFoundError')
          return
        }
        assert(false)
      })

      it('throws MissingFulfillmentError', function * () {
        nock('http://red.example')
          .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(404, {
            id: 'MissingFulfillmentError',
            message: 'This transfer has no fulfillment'
          })
        try {
          yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        } catch (err) {
          assert.equal(err.name, 'MissingFulfillmentError')
          return
        }
        assert(false)
      })

      it('throws an ExternalError on 500', function * () {
        nock('http://red.example')
          .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
          .basicAuth({user: 'mike', pass: 'mike'})
          .reply(500)
        try {
          yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        } catch (err) {
          assert.equal(err.name, 'ExternalError')
          assert.equal(err.message, 'Remote error: status=500')
          return
        }
        assert(false)
      })

      it('throws an ExternalError on error', function * () {
        nock('http://red.example')
          .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
          .basicAuth({user: 'mike', pass: 'mike'})
          .replyWithError('broken')
        try {
          yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        } catch (err) {
          assert.equal(err.name, 'ExternalError')
          assert.equal(err.message, 'Remote error: message=broken')
          return
        }
        assert(false)
      })
    })

    describe('rejectIncomingTransfer', function () {
      it('returns null on success', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
          .reply(200, {whatever: true})
        yield assertResolve(
          this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'),
          null)
      })

      it('throws NotAcceptedError on UnauthorizedError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
          .reply(422, {id: 'UnauthorizedError', message: 'error'})
        this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
          .should.be.rejectedWith(errors.NotAcceptedError, 'error')
          .notify(done)
      })

      it('throws TransferNotFoundError on NotFoundError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
          .reply(404, {id: 'NotFoundError', message: 'error'})
        this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
          .should.be.rejectedWith(errors.TransferNotFoundError, 'error')
          .notify(done)
      })

      it('throws AlreadyFulfilledError on InvalidModificationError', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
          .reply(404, {id: 'InvalidModificationError', message: 'error'})
        this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
          .should.be.rejectedWith(errors.AlreadyFulfilledError, 'error')
          .notify(done)
      })

      it('throws ExternalError on 500', function (done) {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
          .reply(500)
        this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
          .should.be.rejectedWith('Remote error: status=500')
          .notify(done)
      })
    })
  })
})

function * assertResolve (promise, expected) {
  assert(promise instanceof Promise)
  assert.deepEqual(yield promise, expected)
}
