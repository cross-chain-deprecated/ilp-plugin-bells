'use strict'

const parseURL = require('url').parse
const co = require('co')
const request = require('co-request')
const WebSocket = require('ws')
const reconnectCore = require('reconnect-core')
const debug = require('debug')('ilp-plugin-bells:plugin')
const errors = require('../errors')
const ExternalError = require('../errors/external-error')
const UnrelatedNotificationError = require('../errors/unrelated-notification-error')
const UnreachableError = require('../errors/unreachable-error')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const isNil = require('lodash/fp/isNil')
const omitNil = require('lodash/fp/omitBy')(isNil)
const startsWith = require('lodash/fp/startsWith')
const find = require('lodash/find')

const backoffMin = 1000
const backoffMax = 30000

const REQUIRED_LEDGER_URLS = [ 'transfer', 'transfer_fulfillment', 'transfer_rejection', 'account', 'account_transfers', 'message' ]

function wait (ms) {
  return function (done) {
    setTimeout(done, ms)
  }
}

function * requestRetry (opts, errorMessage, credentials) {
  let delay = backoffMin
  while (true) {
    debug('connecting to account ' + opts.uri)
    try {
      let res = yield request(Object.assign(
        {json: true},
        requestCredentials(credentials),
        opts))
      if (res.statusCode >= 400 && res.statusCode < 500) {
        break
      }
      debug('request status ' + res.statusCode + ' retrying connection')
      return res
    } catch (err) {
      debug('http request failed: ', err)
      delay = Math.min(Math.floor(1.5 * delay), backoffMax)
      yield wait(delay)
    }
  }
  debug('http request failed. aborting.')
  throw new Error(errorMessage)
}

class FiveBellsLedger extends EventEmitter2 {
  constructor (options) {
    super()

    if (typeof options !== 'object') {
      throw new TypeError('Expected an options object, received: ' + typeof options)
    }

    if (options.prefix) {
      if (typeof options.prefix !== 'string') {
        throw new TypeError('Expected options.prefix to be a string, received: ' + typeof options.prefix)
      }
      if (options.prefix.slice(-1) !== '.') {
        throw new Error('Expected options.prefix to end with "."')
      }
    }

    this.configPrefix = options.prefix
    this.host = options.host || null
    this.credentials = {
      account: options.account,
      username: options.username,
      password: options.password,
      cert: options.cert,
      key: options.key,
      ca: options.ca
    }
    this.connector = options.connector || null

    this.debugReplyNotifications = options.debugReplyNotifications || false

    this.info = null
    this.connection = null
    this.connected = false
    this.urls = null
  }

  connect () {
    return co(this._connect.bind(this))
  }

  * _connect () {
    const accountUri = this.credentials.account

    if (this.connection) {
      debug('already connected, ignoring connection request')
      return Promise.resolve(null)
    }

    // Resolve account information
    const res = yield requestRetry({
      method: 'GET',
      uri: accountUri,
      json: true
    }, 'Failed to resolve ledger URI from account URI', this.credentials)

    if (!res.body.ledger) {
      throw new Error('Failed to resolve ledger URI from account URI')
    }
    this.host = res.body.ledger
    // Set the username but don't overwrite the username in case it was provided
    if (!this.credentials.username) {
      this.credentials.username = res.body.name
    }

    // Resolve ledger metadata
    const ledgerMetadata = yield this._fetchLedgerMetadata()
    this.urls = parseAndValidateLedgerUrls(ledgerMetadata.urls)
    debug('using service urls:', this.urls)

    // Set ILP prefix
    const ledgerPrefix = ledgerMetadata.ilp_prefix
    this.prefix = this.configPrefix || ledgerMetadata.ilp_prefix

    if (ledgerPrefix && this.configPrefix && ledgerPrefix !== this.configPrefix) {
      console.warn('ilp-plugin-bells: ledger prefix (' + ledgerPrefix +
        ') does not match locally configured prefix (' + this.configPrefix + ')')
    }
    if (!this.prefix) {
      throw new Error('Unable to set prefix from ledger or from local config')
    }

    const notificationsUrl = this.urls.account_transfers.replace(':name', this.credentials.username)
    debug('subscribing to transfer notifications: ' + notificationsUrl)
    const auth = this.credentials.password && this.credentials.username &&
                   this.credentials.username + ':' + this.credentials.password
    const options = {
      headers: auth && {
        Authorization: 'Basic ' + new Buffer(auth, 'utf8').toString('base64')
      },
      cert: this.credentials.cert,
      key: this.credentials.key,
      ca: this.credentials.ca
    }

    const reconnect = reconnectCore(() => {
      return new WebSocket(notificationsUrl, omitNil(options))
    })

    return new Promise((resolve, reject) => {
      this.connection = reconnect({immediate: true}, (ws) => {
        ws.on('open', () => {
          debug('ws connected to ' + notificationsUrl)
          resolve(null)
        })
        ws.on('message', (msg) => {
          let notification
          try {
            notification = JSON.parse(msg)
          } catch (err) {
            debug('invalid notification', msg)
            return
          }

          co.wrap(this._handleNotification)
            .call(this, notification.type, notification.resource, notification.related_resources)
            .then(() => {
              if (this.debugReplyNotifications) {
                ws.send(JSON.stringify({ result: 'processed' }))
              }
            })
            .catch((err) => {
              debug('failure while processing notification: ' +
                (err && err.stack) ? err.stack : err)
              if (this.debugReplyNotifications) {
                ws.send(JSON.stringify({
                  result: 'ignored',
                  ignoreReason: {
                    id: err.name,
                    message: err.message
                  }
                }))
              }
            })
        })
        ws.on('error', () => {
          debug('ws connection error on ' + notificationsUrl)
          reject(new UnreachableError('websocket connection error'))
        })
        ws.on('close', () => {
          debug('ws disconnected from ' + notificationsUrl)
          if (this.connected) {
            reject(new UnreachableError('websocket connection error'))
          }
        })

        // reconnect-core expects the disconnect method to be called: `end`
        ws.end = ws.close
      })
      this.connection
        .on('connect', () => {
          this.connected = true
          this.emit('connect')
        })
        .on('disconnect', () => {
          this.connected = false
          this.emit('disconnect')
        })
        .on('error', (err) => {
          debug('ws error on ' + notificationsUrl + ':', err)
          reject(err)
        })
        .connect()
    })
  }

  disconnect () {
    const emitter = this.connection
    if (!emitter) return Promise.resolve(null)
    this.connection = null
    // WebSocket#end doesn't exist, so reconnect-core#disconnect is no good.
    emitter.reconnect = false
    if (emitter._connection) emitter._connection.close()
    return Promise.resolve(null)
  }

  isConnected () {
    return this.connected
  }

  getInfo () {
    return co.wrap(this._getInfo).call(this)
  }

  * _getInfo () {
    if (this.info) return this.info
    const ledgerMetadata = yield this._fetchLedgerMetadata()

    this.info = {
      connectors: ledgerMetadata.connectors,
      precision: ledgerMetadata.precision,
      scale: ledgerMetadata.scale,
      currencyCode: ledgerMetadata.currency_code,
      currencySymbol: ledgerMetadata.currency_symbol
    }
    return this.info
  }

  * _fetchLedgerMetadata () {
    debug('request ledger metadata %s', this.host)
    function throwErr () {
      throw new ExternalError('Unable to determine ledger precision')
    }

    let res
    try {
      res = yield request(this.host, {json: true})
    } catch (e) {
      if (!res || res.statusCode !== 200) {
        debug('getInfo error %s', e)
        throwErr()
      }
    }

    if (!res || res.statusCode !== 200) throwErr()
    if (!res.body.precision || !res.body.scale) throwErr()

    return res.body
  }

  getPrefix () {
    if (!this.prefix) {
      return Promise.reject(new Error('Prefix has not been set'))
    }
    return Promise.resolve(this.prefix)
  }

  getAccount () {
    if (!this.connected) {
      return Promise.reject(new Error('Must be connected before getAccount can be called'))
    }
    return Promise.resolve(this.prefix + this.accountUriToName(this.credentials.account))
  }

  _validateTransfer (transfer) {
    // validator.validate('TransferTemplate', transfer)
  }

  _validateMessage (message) {
    if (message.ledger !== this.host) {
      throw new UnrelatedNotificationError('Notification does not seem related to connector')
    }
  }

  getBalance () {
    return co.wrap(this._getBalance).call(this)
  }

  * _getBalance () {
    const creds = this.credentials
    let res
    try {
      res = yield request(Object.assign({
        method: 'get',
        uri: creds.account,
        json: true
      }, requestCredentials(creds)))
    } catch (e) { }
    if (!res || res.statusCode !== 200) {
      throw new ExternalError('Unable to determine current balance')
    }
    return res.body.balance
  }

  /**
   * @param {Object} message
   * @param {IlpAddress} message.account
   * @param {IlpAddress} message.ledger
   * @param {Object} message.data
   * @param {Object} message.custom (optional)
   * @returns {Promise.<null>}
   */
  sendMessage (message) {
    return co.wrap(this._sendMessage).call(this, message)
  }

  * _sendMessage (message) {
    if (message.ledger !== this.prefix) {
      throw new errors.InvalidFieldsError('invalid ledger')
    }
    if (typeof message.account !== 'string') {
      throw new errors.InvalidFieldsError('invalid account')
    }
    if (typeof message.data !== 'object') {
      throw new errors.InvalidFieldsError('invalid data')
    }

    const destinationAddress = yield this.parseAddress(message.account)
    const fiveBellsMessage = {
      ledger: this.host,
      from: this.urls.account.replace(':name', encodeURIComponent(this.credentials.username)),
      to: this.urls.account.replace(':name', encodeURIComponent(destinationAddress.username)),
      data: message.data
    }

    const sendRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'post',
        uri: this.urls.message,
        body: fiveBellsMessage,
        json: true
      }))
    const body = sendRes.body
    if (sendRes.statusCode >= 400) {
      if (body.id === 'InvalidBodyError') throw new errors.InvalidFieldsError(body.message)
      throw new errors.NotAcceptedError(body.message)
    }
    return null
  }

  sendTransfer (transfer) {
    return co.wrap(this._sendTransfer).call(this, transfer)
  }

  * _sendTransfer (transfer) {
    if (typeof transfer.account !== 'string') {
      throw new errors.InvalidFieldsError('invalid account')
    }
    if (typeof transfer.amount !== 'string' || +transfer.amount <= 0) {
      throw new errors.InvalidFieldsError('invalid amount')
    }

    const sourceAddress = yield this.parseAddress(transfer.account)
    const fiveBellsTransfer = omitNil({
      id: this.urls.transfer.replace(':id', transfer.id),
      ledger: this.host,
      debits: [omitNil({
        account: this.credentials.account,
        amount: transfer.amount,
        authorized: true,
        memo: transfer.noteToSelf
      })],
      credits: [omitNil({
        account: this.urls.account.replace(':name', encodeURIComponent(sourceAddress.username)),
        amount: transfer.amount,
        memo: transfer.data
      })],
      execution_condition: transfer.executionCondition,
      cancellation_condition: transfer.cancellationCondition,
      expires_at: transfer.expiresAt,
      additional_info: transfer.cases ? { cases: transfer.cases } : undefined
    })

    // If Atomic mode, add destination transfer to notification targets
    if (transfer.cases) {
      for (let caseUri of transfer.cases) {
        debug('add case notification for ' + caseUri)
        const res = yield request({
          method: 'POST',
          uri: caseUri + '/targets',
          body: [ this.urls.transfer_fulfillment.replace(':id', transfer.id) ],
          json: true
        })

        if (res.statusCode !== 200) {
          throw new Error('Unexpected status code: ' + res.statusCode)
        }
      }
    }

    debug('submitting transfer: ', JSON.stringify(fiveBellsTransfer))

    const sendRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'put',
        uri: fiveBellsTransfer.id,
        body: fiveBellsTransfer,
        json: true
      }))
    const body = sendRes.body
    if (sendRes.statusCode >= 400) {
      debug('error submitting transfer:', sendRes.statusCode, JSON.stringify(body))
      if (body.id === 'InvalidBodyError') throw new errors.InvalidFieldsError(body.message)
      if (body.id === 'InvalidModificationError') throw new errors.DuplicateIdError(body.message)
      throw new errors.NotAcceptedError(body.message)
    }

    // TODO: If already executed, fetch fulfillment and forward to source

    return null
  }

  fulfillCondition (transferId, conditionFulfillment) {
    return co.wrap(this._fulfillCondition).call(this, transferId, conditionFulfillment)
  }

  * _fulfillCondition (transferId, conditionFulfillment) {
    const fulfillmentRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'put',
        uri: this.urls.transfer_fulfillment.replace(':id', transferId),
        body: conditionFulfillment,
        headers: {
          'content-type': 'text/plain'
        }
      }))
    const body = getResponseJSON(fulfillmentRes)

    if (fulfillmentRes.statusCode >= 400 && body) {
      if (body.id === 'InvalidBodyError') throw new errors.InvalidFieldsError(body.message)
      if (body.id === 'UnmetConditionError') throw new errors.NotAcceptedError(body.message)
      if (body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(body.message)
      if (body.id === 'NotFoundError') throw new errors.TransferNotFoundError(body.message)
      if (body.id === 'InvalidModificationError' &&
       body.message === 'Transfers in state rejected may not be executed') {
        throw new errors.AlreadyRolledBackError(body.message)
      }
    }

    // TODO check the timestamp the ledger sends back
    // See https://github.com/interledgerjs/five-bells-ledger/issues/149
    if (fulfillmentRes.statusCode === 200 || fulfillmentRes.statusCode === 201) {
      return null
    } else {
      throw new ExternalError('Failed to submit fulfillment for transfer: ' + transferId + ' Error: ' + (fulfillmentRes.body ? JSON.stringify(fulfillmentRes.body) : fulfillmentRes.error))
    }
  }

  /**
   * @param {String} transferId
   * @returns {Promise<String>}
   */
  getFulfillment (transferId) {
    return co.wrap(this._getFulfillment).call(this, transferId)
  }

  * _getFulfillment (transferId) {
    let res
    try {
      res = yield request(Object.assign({
        method: 'get',
        uri: this.urls.transfer_fulfillment.replace(':id', transferId),
        json: true
      }, requestCredentials(this.credentials)))
    } catch (err) {
      throw new ExternalError('Remote error: message=' + err.message)
    }

    if (res.statusCode === 200) return res.body
    if (res.statusCode >= 400 && res.body) {
      if (res.body.id === 'MissingFulfillmentError') throw new errors.MissingFulfillmentError(res.body.message)
      if (res.body.id === 'TransferNotFoundError') throw new errors.TransferNotFoundError(res.body.message)
      if (res.body.id === 'AlreadyRolledBackError') throw new errors.AlreadyRolledBackError(res.body.message)
      if (res.body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(res.body.message)
    }
    throw new ExternalError('Remote error: status=' + (res && res.statusCode))
  }

  /**
   * @param {String} transferId
   * @param {String} rejectionMessage
   * @returns {Promise<null>}
   */
  rejectIncomingTransfer (transferId, rejectionMessage) {
    return co.wrap(this._rejectIncomingTransfer).call(this, transferId, rejectionMessage)
  }

  * _rejectIncomingTransfer (transferId, rejectionMessage) {
    const rejectionRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'put',
        uri: this.urls.transfer_rejection.replace(':id', transferId),
        body: rejectionMessage
      }))
    const body = getResponseJSON(rejectionRes)

    if (rejectionRes.statusCode >= 400) {
      if (body && body.id === 'UnauthorizedError') throw new errors.NotAcceptedError(body.message)
      if (body && body.id === 'NotFoundError') throw new errors.TransferNotFoundError(body.message)
      if (body && body.id === 'InvalidModificationError') throw new errors.AlreadyFulfilledError(body.message)
      if (body && body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(body.message)
      throw new ExternalError('Remote error: status=' + rejectionRes.statusCode)
    }
    return null
  }

  * _handleNotification (type, data, relatedResources) {
    if (type === 'connect') {
      debug('notify connect')
    } else if (type === 'transfer') {
      debug('notify transfer', data.state, data.id)
      return yield this._handleTransferNotification(data, relatedResources)
    } else if (type === 'message') {
      debug('notify message', data.account)
      return yield this._handleMessageNotification(data)
    } else {
      throw new UnrelatedNotificationError('Invalid notification type: ' + type)
    }
  }

  * _handleTransferNotification (fiveBellsTransfer, relatedResources) {
    this._validateTransfer(fiveBellsTransfer)

    let handled = false
    for (let credit of fiveBellsTransfer.credits) {
      if (credit.account === this.credentials.account) {
        handled = true

        const transfer = omitNil({
          id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
          direction: 'incoming',
          // TODO: What if there are multiple debits?
          account: this.prefix + this.accountUriToName(fiveBellsTransfer.debits[0].account),
          ledger: this.prefix,
          amount: credit.amount,
          data: credit.memo,
          executionCondition: fiveBellsTransfer.execution_condition,
          cancellationCondition: fiveBellsTransfer.cancellation_condition,
          expiresAt: fiveBellsTransfer.expires_at,
          cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
            ? fiveBellsTransfer.additional_info.cases
            : undefined
        })

        if (fiveBellsTransfer.state === 'prepared') {
          yield this.emitAsync('incoming_prepare', transfer)
        }
        if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
          yield this.emitAsync('incoming_transfer', transfer)
        }

        if (fiveBellsTransfer.state === 'executed' && relatedResources &&
            relatedResources.execution_condition_fulfillment) {
          yield this.emitAsync('incoming_fulfill', transfer,
            relatedResources.execution_condition_fulfillment)
        }

        if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
            relatedResources.cancellation_condition_fulfillment) {
          yield this.emitAsync('incoming_cancel', transfer,
            relatedResources.cancellation_condition_fulfillment)
        } else if (fiveBellsTransfer.state === 'rejected') {
          const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
          if (rejectedCredit) {
            yield this.emitAsync('incoming_reject', transfer,
              new Buffer(rejectedCredit.rejection_message, 'base64').toString())
          } else {
            yield this.emitAsync('incoming_cancel', transfer, 'transfer timed out.')
          }
        }
      }
    }

    for (let debit of fiveBellsTransfer.debits) {
      if (debit.account === this.credentials.account) {
        handled = true

        // This connector only launches transfers with one credit, so there
        // should never be more than one credit.
        const credit = fiveBellsTransfer.credits[0]

        const transfer = omitNil({
          id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
          direction: 'outgoing',
          account: this.prefix + this.accountUriToName(credit.account),
          ledger: this.prefix,
          amount: debit.amount,
          data: credit.memo,
          noteToSelf: debit.memo,
          executionCondition: fiveBellsTransfer.execution_condition,
          cancellationCondition: fiveBellsTransfer.cancellation_condition,
          expiresAt: fiveBellsTransfer.expires_at,
          cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
            ? fiveBellsTransfer.additional_info.cases
            : undefined
        })

        if (fiveBellsTransfer.state === 'prepared') {
          yield this.emitAsync('outgoing_prepare', transfer)
        }
        if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
          yield this.emitAsync('outgoing_transfer', transfer)
        }

        if (fiveBellsTransfer.state === 'executed' && relatedResources &&
            relatedResources.execution_condition_fulfillment) {
          yield this.emitAsync('outgoing_fulfill', transfer,
            relatedResources.execution_condition_fulfillment)
        }

        if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
            relatedResources.cancellation_condition_fulfillment) {
          yield this.emitAsync('outgoing_cancel', transfer,
            relatedResources.cancellation_condition_fulfillment)
        } else if (fiveBellsTransfer.state === 'rejected') {
          const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
          if (rejectedCredit) {
            yield this.emitAsync('outgoing_reject', transfer,
              new Buffer(rejectedCredit.rejection_message, 'base64').toString())
          } else {
            yield this.emitAsync('outgoing_cancel', transfer, 'transfer timed out.')
          }
        }
      }
    }
    if (!handled) {
      throw new UnrelatedNotificationError('Notification does not seem related to connector')
    }
  }

  _handleMessageNotification (message) {
    this._validateMessage(message)
    return this.emitAsync('incoming_message', {
      ledger: this.prefix,
      account: this.prefix + this.accountUriToName(message.account || message.to),
      data: message.data
    })
  }

  /**
   * Get the account name from "http://red.example/accounts/alice" (where
   * accountUriTemplate is "http://red.example/accounts/:name").
   */
  accountUriToName (accountURI) {
    const templatePath = parseURL(this.urls.account).path.split('/')
    const accountPath = parseURL(accountURI).path.split('/')
    for (let i = 0; i < templatePath.length; i++) {
      if (templatePath[i] === ':name') return accountPath[i]
    }
  }

  * parseAddress (address) {
    const prefix = yield this.getPrefix()

    if (!startsWith(prefix, address)) {
      debug('destination address has invalid prefix', { prefix, address })
      throw new errors.InvalidFieldsError('Destination address "' + address + '" must start ' +
        'with ledger prefix "' + prefix + '"')
    }

    const addressParts = address.substr(this.prefix.length).split('.')
    return {
      ledger: prefix,
      username: addressParts.slice(0, 1).join('.'),
      additionalParts: addressParts.slice(1).join('.')
    }
  }
}

function requestCredentials (credentials) {
  return omitNil({
    auth: credentials.username && credentials.password && {
      user: credentials.username,
      pass: credentials.password
    },
    cert: credentials.cert,
    key: credentials.key,
    ca: credentials.ca
  })
}

function getResponseJSON (res) {
  const contentType = res.headers['content-type']
  if (!contentType) return
  if (contentType.indexOf('application/json') !== 0) return
  return JSON.parse(res.body)
}

function parseAndValidateLedgerUrls (metadataUrls) {
  if (!metadataUrls) {
    throw new ExternalError('ledger metadata does not include a urls map')
  }

  const urls = {}
  REQUIRED_LEDGER_URLS.forEach((service) => {
    if (!metadataUrls[service]) {
      throw new ExternalError('ledger metadata does not include ' + service + ' url')
    }

    if (service === 'account_transfers') {
      if (metadataUrls[service].indexOf('ws') !== 0) {
        throw new ExternalError('ledger metadata ' + service + ' url must be a full ws(s) url')
      }
    } else {
      if (metadataUrls[service].indexOf('http') !== 0) {
        throw new ExternalError('ledger metadata ' + service + ' url must be a full http(s) url')
      }
    }
    urls[service] = metadataUrls[service]
  })

  return urls
}

module.exports = FiveBellsLedger
