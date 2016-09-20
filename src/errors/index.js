'use strict'

class InvalidFieldsError extends Error {
  constructor (message) {
    super(message)
    this.name = 'InvalidFieldsError'
  }
}

class TransferNotFoundError extends Error {
  constructor (message) {
    super(message)
    this.name = 'TransferNotFoundError'
  }
}

class MissingFulfillmentError extends Error {
  constructor (message) {
    super(message)
    this.name = 'MissingFulfillmentError'
  }
}

class NotAcceptedError extends Error {
  constructor (message) {
    super(message)
    this.name = 'NotAcceptedError'
  }
}

class AlreadyRolledBackError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AlreadyRolledBackError'
  }
}

class AlreadyFulfilledError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AlreadyFulfilledError'
  }
}

class DuplicateIdError extends Error {
  constructor (message) {
    super(message)
    this.name = 'DuplicateIdError'
  }
}

class TransferNotConditionalError extends Error {
  constructor (message) {
    super(message)
    this.name = 'TransferNotConditionalError'
  }
}

module.exports = {
  AlreadyFulfilledError,
  AlreadyRolledBackError,
  InvalidFieldsError,
  TransferNotFoundError,
  TransferNotConditionalError,
  DuplicateIdError,
  MissingFulfillmentError,
  NotAcceptedError
}
