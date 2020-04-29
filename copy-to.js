'use strict'

module.exports = function (txt, options) {
  return new CopyStreamQuery(txt, options)
}

var Transform = require('stream').Transform
var util = require('util')
var code = require('./message-formats')

var CopyStreamQuery = function (text, options) {
  Transform.call(this, options)
  this.text = text
  this._gotCopyOutResponse = false
  this.rowCount = 0
}

util.inherits(CopyStreamQuery, Transform)

var eventTypes = ['close', 'data', 'end', 'error']

CopyStreamQuery.prototype.submit = function (connection) {
  connection.query(this.text)
  this.connection = connection
  this.connection.removeAllListeners('copyData')
  connection.stream.pipe(this)
}

CopyStreamQuery.prototype._detach = function () {
  var connectionStream = this.connection.stream
  connectionStream.unpipe(this)

  // unpipe can pause the stream but also underlying onData event can potentially pause the stream because of hitting
  // the highWaterMark and pausing the stream, so we resume the stream in the next tick after the underlying onData
  // event has finished
  process.nextTick(function () {
    connectionStream.resume()
  })
}

CopyStreamQuery.prototype._transform = function (chunk, enc, cb) {
  var offset = 0
  var Byte1Len = 1
  var Int32Len = 4
  if (this._remainder && chunk) {
    chunk = Buffer.concat([this._remainder, chunk])
  }

  var length
  var messageCode
  var needPush = false

  var buffer = Buffer.alloc(chunk.length)
  var buffer_offset = 0

  var self = this
  var pushBufferIfneeded = function () {
    if (needPush && buffer_offset > 0) {
      self.push(buffer.slice(0, buffer_offset))
      buffer_offset = 0
    }
  }

  while (chunk.length - offset >= Byte1Len + Int32Len) {
    var messageCode = chunk[offset]

    //console.log('PostgreSQL message ' + String.fromCharCode(messageCode))
    switch (messageCode) {
      // detect COPY start
      case code.CopyOutResponse:
        if (!this._gotCopyOutResponse) {
          this._gotCopyOutResponse = true
        } else {
          this.emit('error', new Error('Unexpected CopyOutResponse message (H)'))
        }
        break

      // meaningful row
      case code.CopyData:
        needPush = true
        break

      // standard interspersed messages. discard
      case code.ParameterStatus:
      case code.NoticeResponse:
      case code.NotificationResponse:
        break

      case code.ErrorResponse:
      case code.CopyDone:
        pushBufferIfneeded()
        this._detach()
        this.push(null)
        return cb()
        break
      default:
        this.emit('error', new Error('Unexpected PostgreSQL message ' + String.fromCharCode(messageCode)))
    }

    length = chunk.readUInt32BE(offset + Byte1Len)
    if (chunk.length >= offset + Byte1Len + length) {
      offset += Byte1Len + Int32Len
      if (needPush) {
        var row = chunk.slice(offset, offset + length - Int32Len)
        this.rowCount++
        row.copy(buffer, buffer_offset)
        buffer_offset += row.length
      }
      offset += length - Int32Len
    } else {
      // we need more chunks for a complete message
      break
    }
  }

  pushBufferIfneeded()

  if (chunk.length - offset) {
    var slice = chunk.slice(offset)
    this._remainder = slice
  } else {
    this._remainder = false
  }
  cb()
}

CopyStreamQuery.prototype.handleError = function (e) {
  this.emit('error', e)
}

CopyStreamQuery.prototype.handleCopyData = function (chunk) {}

CopyStreamQuery.prototype.handleCommandComplete = function () {}

CopyStreamQuery.prototype.handleReadyForQuery = function () {}
