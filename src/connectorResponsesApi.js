const debug = require('debug')('botium-connector-chatgpt')
const OpenAI = require('openai')
const { toFile } = require('openai/uploads')
const _ = require('lodash')

const Capabilities = require('./Capabilities')

const RequiredCapabilities = [
  Capabilities.CHATGPT_API_KEY,
  Capabilities.CHATGPT_MODEL
]

class BotiumConnectorChatGPTResponsesAPI {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
    this.openai = null
    this.conversation = []
    this.fileSendMode = 'upload'
  }

  Validate () {
    debug('Validate called')
    for (const cap of RequiredCapabilities) {
      if (!this.caps[cap]) throw new Error(`${cap} capability required`)
    }
    if (this.caps[Capabilities.CHATGPT_FILE_SEND_MODE]) {
      const mode = String(this.caps[Capabilities.CHATGPT_FILE_SEND_MODE]).toLowerCase()
      if (mode !== 'base64' && mode !== 'upload') {
        throw new Error(`CHATGPT_FILE_SEND_MODE must be "base64" or "upload", got "${this.caps[Capabilities.CHATGPT_FILE_SEND_MODE]}"`)
      }
    }
  }

  Build () {
    debug('Build called')
    this.openai = new OpenAI({
      apiKey: this.caps[Capabilities.CHATGPT_API_KEY]
    })
    this.fileSendMode = String(this.caps[Capabilities.CHATGPT_FILE_SEND_MODE] || 'upload').toLowerCase() === 'upload' ? 'upload' : 'base64'
  }

  async Start () {
    debug('Start called')
    this.conversation = []
    if (this.caps[Capabilities.CHATGPT_PROMPT]) {
      this.conversation.push({
        role: 'system',
        content: this.caps[Capabilities.CHATGPT_PROMPT]
      })
    }
  }

  async UserSays (msg) {
    const uploadedFileIds = []
    const buildUserContent = async () => {
      const userContent = []
      if (msg.messageText) {
        userContent.push({ type: 'input_text', text: msg.messageText })
      }

      for (const a of (msg.media || [])) {
        const name = a.mediaUri || a?.altText
        const buffer = a?.buffer ? (Buffer.isBuffer(a.buffer) ? a.buffer : Buffer.from(a.buffer)) : null
        const mimeType = a?.mimeType
        if (!buffer) {
          debug(`Skipping attachment without buffer: ${name}`)
          continue
        }
        const isImage = mimeType?.startsWith('image/')
        const isStructuredTextMime = ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/csv'].includes(mimeType)
        const isTextByMime = mimeType?.startsWith('text/') || isStructuredTextMime
        const isTextByName = /\.(txt|md|json|xml|ya?ml|csv)$/i.test(name)
        const isText = isTextByMime || (!mimeType && isTextByName)

        if (isImage) {
          if (this.fileSendMode === 'base64') {
            debug('Sending image as base64')
            const imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
            userContent.push({
              type: 'input_image',
              image_url: imageUrl
            })
          } else {
            debug('Uploading image to OpenAI')
            let uploaded = null
            try {
              const fileForUpload = await toFile(buffer, name, { type: mimeType || 'application/octet-stream' })
              uploaded = await this.openai.files.create({
                file: fileForUpload,
                purpose: 'assistants'
              })
              debug(`Upload finished, id=${uploaded?.id || 'n/a'}`)
            } catch (e) {
              debug(`Error uploading image to OpenAI: ${e?.message || e}`)
              throw new Error(`Error uploading image to OpenAI: ${e?.message || e}`)
            }

            if (uploaded?.id) {
              uploadedFileIds.push(uploaded.id)
              userContent.push({
                type: 'input_image',
                file_id: uploaded.id
              })
            } else {
              debug(`Upload did not return id for ${name}, skipping`)
            }
          }
        } else if (isText) {
          debug('Sending text inline')
          const textContent = buffer.toString('utf8')
          userContent.push({
            type: 'input_text',
            text: `File attachment (prepared, no need to download or read out)\nname:\n${name}\nContent:\n${textContent}`
          })
          debug(`Inline text attachment content: ${JSON.stringify(userContent)}`)
        } else {
          debug(`Skipping attachment of file "${name}" type ${mimeType}`)
        }
      }
      return userContent
    }

    const currentUserContent = await buildUserContent()
    const currentUserMessage = {
      role: 'user',
      content: currentUserContent
    }
    this.conversation.push(currentUserMessage)

    try {
      const params = {
        model: this.caps[Capabilities.CHATGPT_MODEL],
        input: this.conversation
      }
      if (!_.isNil(this.caps[Capabilities.CHATGPT_TOOLS])) {
        params.tools = this.caps[Capabilities.CHATGPT_TOOLS].split(',').map(tool => ({ type: tool.trim() }))
      }
      if (!_.isNil(this.caps[Capabilities.CHATGPT_INCLUDE])) {
        params.include = this.caps[Capabilities.CHATGPT_INCLUDE].split(',').map(include => include.trim())
      }
      if (!_.isNil(this.caps[Capabilities.CHATGPT_TEMPERATURE])) {
        params.temperature = this.caps[Capabilities.CHATGPT_TEMPERATURE]
      }
      if (!_.isNil(this.caps[Capabilities.CHATGPT_MAX_TOKENS])) {
        params.max_output_tokens = this.caps[Capabilities.CHATGPT_MAX_TOKENS]
      }
      if (!_.isNil(this.caps[Capabilities.CHATGPT_REASONING_EFFORT])) {
        params.reasoning = { effort: this.caps[Capabilities.CHATGPT_REASONING_EFFORT] }
      }

      const response = await this.openai.responses.create(params)
      debug(`UserSays, response: ${JSON.stringify(response)}`)

      let assistantText = ''
      if (response.output_text) {
        assistantText = response.output_text
      } else if (Array.isArray(response.output)) {
        assistantText = response.output.map(item => {
          if (!item || !Array.isArray(item.content)) return ''
          return item.content.map(c => (c?.text?.value || c?.text || '')).join('')
        }).join('\n').trim()
      }

      if (assistantText) {
        const assistantMessage = { role: 'assistant', content: assistantText }
        this.conversation.push(assistantMessage)
        const botMsg = {
          sender: 'bot',
          sourceData: response,
          messageText: assistantText
        }
        setTimeout(() => this.queueBotSays(botMsg), 0)
      }
    } catch (error) {
      debug('Error sending message to ChatGPT (Responses API):', error)
      throw new Error(`Error from ChatGPT: ${error.message}`)
    } finally {
      if (uploadedFileIds.length > 0) {
        try {
          await Promise.all(uploadedFileIds.map(id => this.openai.files.del(id).catch(e => debug(`File delete failed for ${id}: ${e?.message || e}`))))
        } catch (e) {
          debug(`Cleanup error: ${e?.message || e}`)
        }
      }
    }
  }

  async Stop () {
    debug('Stop called')
    this.conversation = []
  }

  async Clean () {
    debug('Clean called')
    this.openai = null
  }
}

module.exports = BotiumConnectorChatGPTResponsesAPI
