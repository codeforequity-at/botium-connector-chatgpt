const fs = require('fs')
const path = require('path')

const PluginClass = require('./src/connectorResponsesApi')

const logo = fs.readFileSync(path.join(__dirname, 'logo.png')).toString('base64')

module.exports = {
  PluginVersion: 1,
  PluginClass: PluginClass,
  PluginDesc: {
    name: 'ChatGPT (OpenAI)',
    avatar: logo,
    provider: 'OpenAI',
    capabilities: [
      {
        name: 'CHATGPT_API_KEY',
        label: 'OpenAI API Key',
        type: 'secret',
        required: true,
        description: 'OpenAI API key used for authentication.'
      },
      {
        name: 'CHATGPT_MODEL',
        label: 'Model',
        type: 'string',
        required: true,
        description: 'Chat model to use (e.g., gpt-4o, gpt-4o-mini).'
      },
      {
        name: 'CHATGPT_PROMPT',
        label: 'System Prompt',
        type: 'string',
        required: false,
        description: 'Optional system prompt to initialize the assistant.'
      }
    ]
  }
}
