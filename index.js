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
    features: {
      sendAttachments: true
    },
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
      },
      {
        name: 'CHATGPT_FILE_SEND_MODE',
        label: 'File Send Mode',
        type: 'choice',
        required: false,
        advanced: true,
        description: 'How to send attachments to OpenAI.',
        choices: [
          { name: 'Base64 (image only)', key: 'base64' },
          { name: 'Upload (all file types)', key: 'upload' }
        ]
      }
    ]
  }
}
