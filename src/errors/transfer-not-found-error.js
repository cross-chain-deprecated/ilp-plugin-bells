'use strict'

const NotFoundError = require('./not-found-error')

class TransferNotFoundError extends NotFoundError {
  * handler (ctx, log) {
    log.warn('Transfer not found: ' + this.message)
    ctx.status = 404
    ctx.body = {
      id: this.name,
      message: this.message
    }
  }
}

module.exports = TransferNotFoundError
