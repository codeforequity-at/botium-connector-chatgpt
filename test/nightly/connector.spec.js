require('dotenv').config()
const assert = require('chai').assert
const Connector = require('../../src/connectorResponsesApi')
const debug = require('debug')('botium-connector-chatgpt-test')
const _ = require('lodash')

const { readCaps } = require('./helper')

describe('connector', function () {
  beforeEach(async function () {
    this.init = async (caps) => {
      debug('Connector starting')
      caps = Object.assign({}, readCaps(), caps)
      this.botMsgs = []
      const queueBotSays = (botMsg) => {
        debug(`Incoming message from bot: ${JSON.stringify(botMsg)}`)
        if (this.botMsgPromiseResolve) {
          if (!_.isError(botMsg)) {
            this.botMsgPromiseResolve(botMsg)
          } else {
            this.botMsgPromiseReject(botMsg)
          }
          this.botMsgPromiseResolve = null
          this.botMsgPromiseReject = null
        } else {
          this.botMsgs.push(botMsg)
        }
      }
      this.connector = new Connector({
        queueBotSays,
        caps
      })
      await this.connector.Validate()
      await this.connector.Build()
      await this.connector.Start()

      this._nextBotMsg = async () => {
        const nextBotMsg = this.botMsgs.shift()
        if (nextBotMsg) {
          if (_.isError(nextBotMsg)) {
            throw nextBotMsg
          }
          return nextBotMsg
        }
        return new Promise((resolve, reject) => {
          this.botMsgPromiseResolve = resolve
          this.botMsgPromiseReject = reject
        })
      }
      debug(`Connector started with capabilities: ${JSON.stringify(caps)}`)
    }
    const caps = readCaps()
    await this.init(caps)
  })

  
  it('should successfully get an answer for say hello', async function () {
    debug('Sending message "What is Botium?"')
    await this.connector.UserSays({ messageText: 'What is Botium in one sentence?' })
    debug('Sending message done, waiting for bot response"')

    const botMsg = await this._nextBotMsg()
    assert.isTrue(botMsg?.messageText && botMsg.messageText.length > 0, 'Expected bot response')
    debug(`Bot response: ${botMsg.messageText}`)
  }).timeout(30000)

  afterEach(async function () {
    debug('afterEach called, stopping connector')
    if (this.connector) {
      await this.connector.Stop()
      await this.connector.Clean()
    }
    this.botMsgPromiseResolve = null
    this.botMsgPromiseReject = null
    this.botMsgs = null
    this._nextBotMsg = null
    this.init = null
    this.connector = null
  })
})
