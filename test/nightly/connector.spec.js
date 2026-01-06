require('dotenv').config()
const assert = require('chai').assert
const Connector = require('../../src/connectorResponsesApi')
const debug = require('debug')('botium-connector-chatgpt-test')
const _ = require('lodash')
const fs = require('fs')
const path = require('path')

const { readCaps } = require('./helper')

const BOTIUM_PNG_BASE64 = fs.readFileSync(path.join(__dirname, 'botium.png'))
const BOTIUM_TXT_BASE64 = fs.readFileSync(path.join(__dirname, 'botium.txt'))

describe('connector', function () {
  beforeEach(async function () {
    this.init = async (caps) => {
      debug('Connector starting')
      caps = Object.assign({}, readCaps(), caps)
      this.botMsgs = []
      const queueBotSays = (botMsg) => {
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
  }).timeout(300000)

  it('should accept base64 attachment and respond', async function () {
    await this.connector.UserSays({
      messageText: 'Return just the text of the image.',
      media: [
        {
          name: 'botium.png',
          mimeType: 'image/png',
          buffer: BOTIUM_PNG_BASE64
        }
      ]
    })
    const botMsg = await this._nextBotMsg()
    assert.equal(botMsg?.messageText?.toLowerCase(), 'botium')
  }).timeout(60000)

  it('should accept uploaded attachment and respond', async function () {
    await this.init({ CHATGPT_FILE_SEND_MODE: 'upload' })

    await this.connector.UserSays({
      messageText: 'Return just the text of the image.',
      media: [
        {
          name: 'botium.png',
          mimeType: 'image/png',
          buffer: BOTIUM_PNG_BASE64
        }
      ]
    })
    const botMsg = await this._nextBotMsg()
    assert.equal(botMsg?.messageText?.toLowerCase(), 'botium')
  }).timeout(60000)

  it('should inline text attachment content', async function () {
    await this.connector.UserSays({
      messageText: 'Just return the text of the attached file',
      media: [
        {
          name: 'botium.txt',
          mimeType: 'text/plain',
          buffer: BOTIUM_TXT_BASE64
        }
      ]
    })
    const botMsg = await this._nextBotMsg()
    assert.equal(botMsg?.messageText?.toLowerCase(), 'botium')
  }).timeout(10000)

  it('should support Botium JSON response format and map messageText', async function () {
    await this.init({ CHATGPT_RESPOND_AS_BOTIUM_JSON: true })
    await this.connector.UserSays({
      messageText: 'Reply as Botium JSON. Set messageText exactly to "botium".'
    })
    const botMsg = await this._nextBotMsg()
    assert.equal(botMsg?.messageText?.toLowerCase(), 'botium')
  }).timeout(30000)

  it('should support Botium JSON response format with buttons', async function () {
    await this.init({ CHATGPT_RESPOND_AS_BOTIUM_JSON: true })
    await this.connector.UserSays({
      messageText: 'Reply as Botium JSON with messageText "test" and include at least one button with text "Click me" and payload "button1".'
    })
    const botMsg = await this._nextBotMsg()
    assert.isTrue(botMsg?.messageText && botMsg.messageText.length > 0, 'Expected messageText')
    assert.isTrue(Array.isArray(botMsg?.buttons), 'Expected buttons array')
    assert.isTrue(botMsg.buttons.length > 0, 'Expected at least one button')
    assert.isTrue(botMsg.buttons.some(b => b.text && b.text.toLowerCase().includes('click')), 'Expected button with "click" text')
  }).timeout(300000)

  it('should support Botium JSON response format when asking about Excel creation', async function () {
    await this.init({ CHATGPT_RESPOND_AS_BOTIUM_JSON: true, CHATGPT_PROMPT:'' })
    await this.connector.UserSays({
      messageText: 'Are you able to create me a multiplication table for the numbers 1 to 10 in excel format?'
    })
    const botMsg = await this._nextBotMsg()
    assert.isTrue(botMsg?.messageText && botMsg.messageText.length > 0, 'Expected messageText')
    assert.isTrue(Array.isArray(botMsg?.attachments), 'Expected attachments array')
    assert.isTrue(botMsg.attachments.length === 1, 'Expected one attachment')
    // Check for Excel-related content in the response
    const hasExcelContent = botMsg.messageText.toLowerCase().includes('excel')
    assert.isTrue(hasExcelContent, 'Expected Excel-related content in response text')
    assert.isTrue(!botMsg.buttons || botMsg.buttons.length === 0, 'Expected at least one button')

  }).timeout(200000)

  it('should support Botium JSON response format with cards', async function () {
    await this.init({ CHATGPT_RESPOND_AS_BOTIUM_JSON: true })
    await this.connector.UserSays({
      messageText: 'Reply as Botium JSON with messageText "test" and include at least one card with title "Test Card" and subtitle "Test Subtitle".'
    })
    const botMsg = await this._nextBotMsg()
    assert.isTrue(botMsg?.messageText && botMsg.messageText.length > 0, 'Expected messageText')
    assert.isTrue(Array.isArray(botMsg?.cards), 'Expected cards array')
    assert.isTrue(botMsg.cards.length > 0, 'Expected at least one card')
    assert.isTrue(botMsg.cards.some(c => c.title && c.title.toLowerCase().includes('test')), 'Expected card with "test" in title')
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
