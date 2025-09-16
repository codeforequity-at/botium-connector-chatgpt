const debug = require('debug')('botium-connector-chatgpt')
const OpenAI = require('openai')
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
  }

  Validate () {
    debug('Validate called')
    for (const cap of RequiredCapabilities) {
      if (!this.caps[cap]) throw new Error(`${cap} capability required`)
    }
  }

  Build () {
    debug('Build called')
    this.openai = new OpenAI({
      apiKey: this.caps[Capabilities.CHATGPT_API_KEY]
    })
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
    debug('UserSays called')
    this.conversation.push({
      role: 'user',
      content: msg.messageText
    })

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
