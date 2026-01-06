const debug = require('debug')('botium-connector-chatgpt')
const OpenAI = require('openai')
const { toFile } = require('openai/uploads')
const _ = require('lodash')
const XLSX = require('xlsx')

const Capabilities = require('./Capabilities')

// JSON Schema for Botium-style message output when CHATGPT_RESPOND_AS_BOTIUM_JSON is enabled
const BOTIUM_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // For strict schemas, OpenAI requires all properties to be listed in "required"
  required: ['messageText', 'buttons', 'media', 'attachments', 'cards', 'intent'],
  properties: {
    messageText: { type: 'string' },
    buttons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'payload'],
        properties: {
          text: { type: 'string' },
          payload: { type: 'string' }
        }
      }
    },
    media: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['mediaUri', 'buffer', 'mimeType', 'altText'],
        properties: {
          mediaUri: { type: ['string', 'null'] },
          buffer: { type: ['string', 'null'] },
          mimeType: { type: 'string' },
          altText: { type: ['string', 'null'] }
        }
      }
    },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'mimeType', 'base64'],
        properties: {
          name: { type: 'string' },
          mimeType: { type: 'string' },
          base64: { type: 'string' }
        }  
      },
    },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'subtitle', 'imageUri', 'buttons'],
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          imageUri: { type: 'string' },
          buttons: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'payload'],
              properties: {
                text: { type: 'string' },
                payload: { type: 'string' }
              }
            }
          }
        }
      }
    },
    intent: { type: 'string' }
  }
}

const RequiredCapabilities = [
  Capabilities.CHATGPT_API_KEY,
  Capabilities.CHATGPT_MODEL
]

/**
 * attachments response is now swiped out, but it could be merged in the future
 */
const BOTIUM_JSON_INSTRUCTIONS = `
Read the text provided by the user and return it.

You may use buttons, media, attachments, and cards only when appropriate for the response.

When returning a Base64 file (for example an Excel file), you must not create a button for it.

Instead:

Return the Base64 file strictly as a attachment using
attachment: { name: "<NAME>", buffer: "<BASE64_STRING>", mime_type: "<MIME_TYPE>" }

Do not wrap Base64 links in a button, link, or clickable element of any kind.

Do not alter, shorten, or reformat Base64 strings.

Do not infer that Base64 content is a URL. Treat it strictly as file data.
`

/**
 * Masks base64 data in objects for better log readability
 * @param {any} obj - Object to mask
 * @returns {any} Object with base64 strings masked
 */
function maskBase64InObject (obj) {
  if (typeof obj === 'string') {
    // Check for data URLs with base64 (e.g., data:image/png;base64,...)
    if (obj.startsWith('data:') && obj.includes(';base64,')) {
      const base64Part = obj.split(';base64,')[1]
      if (base64Part && base64Part.length > 50) {
        return `data:${obj.split(';')[0]};base64,[base64_data_masked:${base64Part.length}_chars]`
      }
    }
    // Check if string looks like base64 (long alphanumeric string)
    // Remove whitespace/newlines for detection, but keep original length for masking
    const trimmed = obj.trim().replace(/\s/g, '')
    if (trimmed.length > 50 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      // Additional check: base64 strings typically have length divisible by 4 (with padding)
      // and contain a good mix of characters
      const hasGoodBase64Ratio = (trimmed.match(/[A-Za-z0-9]/g) || []).length / trimmed.length > 0.8
      if (hasGoodBase64Ratio) {
        return `[base64_data_masked:${obj.length}_chars]`
      }
    }
    return obj
  }
  if (Buffer.isBuffer(obj)) {
    return `[buffer_masked:${obj.length}_bytes]`
  }
  if (Array.isArray(obj)) {
    return obj.map(item => maskBase64InObject(item))
  }
  // Handle Error objects specially
  if (obj instanceof Error) {
    const maskedError = {
      name: obj.name,
      message: maskBase64InObject(obj.message), // Mask base64 in error messages too
      stack: obj.stack
    }
    // Copy any additional properties and mask them (including non-enumerable ones)
    const allKeys = new Set(Object.keys(obj))
    // Check for common error properties that might contain response data
    const commonProps = ['response', 'request', 'data', 'body', 'config', 'cause']
    commonProps.forEach(prop => {
      if (obj[prop] !== undefined) {
        allKeys.add(prop)
      }
    })
    for (const key of allKeys) {
      if (!['name', 'message', 'stack'].includes(key)) {
        maskedError[key] = maskBase64InObject(obj[key])
      }
    }
    return maskedError
  }
  if (obj && typeof obj === 'object') {
    // Handle Buffer serialization format from JSON.stringify
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return `[buffer_masked:${obj.data.length}_bytes]`
    }
    const masked = {}
    for (const [key, value] of Object.entries(obj)) {
      // Mask buffer fields (common in media objects)
      if (key === 'buffer') {
        if (Buffer.isBuffer(value)) {
          masked[key] = `[buffer_masked:${value.length}_bytes]`
        } else if (typeof value === 'string') {
          // Always mask buffer strings that look like base64 (remove whitespace for detection)
          const trimmed = value.trim().replace(/\s/g, '')
          if (trimmed.length > 50 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
            masked[key] = `[base64_data_masked:${value.length}_chars]`
          } else {
            // Even if not clearly base64, mask long buffer strings
            if (value.length > 200) {
              masked[key] = `[buffer_data_masked:${value.length}_chars]`
            } else {
              masked[key] = maskBase64InObject(value)
            }
          }
        } else if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
          masked[key] = `[buffer_masked:${value.data.length}_bytes]`
        } else {
          masked[key] = maskBase64InObject(value)
        }
      } else if (key === 'mediaUri') {
        // Mask mediaUri if it contains base64 data (not a URL)
        if (typeof value === 'string' && value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value) && !value.startsWith('http')) {
          masked[key] = `[base64_data_masked:${value.length}_chars]`
        } else {
          masked[key] = maskBase64InObject(value)
        }
      } else if (key === 'text') {
        // Handle text fields that may contain JSON strings with base64 (common in API responses)
        if (typeof value === 'string') {
          const trimmed = value.trim()
          // Check if it's a JSON string
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(value)
              if (parsed && typeof parsed === 'object') {
                // Recursively mask the parsed object to handle nested base64
                const maskedParsed = maskBase64InObject(parsed)
                masked[key] = JSON.stringify(maskedParsed)
              } else {
                masked[key] = maskBase64InObject(value)
              }
            } catch (e) {
              // JSON parse failed - might be malformed or too large
              // Check if it contains base64 patterns and mask aggressively
              if (value.includes('"buffer"') && value.length > 500) {
                // Likely contains base64 in buffer field, try to mask it
                // Use regex to find and mask base64 strings in buffer fields
                masked[key] = value.replace(/"buffer"\s*:\s*"([^"]+)"/g, (match, base64Content) => {
                  if (base64Content.length > 50) {
                    return `"buffer":"[base64_data_masked:${base64Content.length}_chars]"`
                  }
                  return match
                })
                // Also check for file_base64
                masked[key] = masked[key].replace(/"file_base64"\s*:\s*"([^"]+)"/g, (match, base64Content) => {
                  if (base64Content.length > 50) {
                    return `"file_base64":"[base64_data_masked:${base64Content.length}_chars]"`
                  }
                  return match
                })
              } else {
                // Not JSON, check if it's base64 itself
                const trimmedForBase64 = trimmed.replace(/\s/g, '')
                if (trimmedForBase64.length > 50 && /^[A-Za-z0-9+/=]+$/.test(trimmedForBase64)) {
                  masked[key] = `[base64_data_masked:${value.length}_chars]`
                } else {
                  masked[key] = value
                }
              }
            }
          } else {
            // Not JSON, check if it's base64
            const trimmedForBase64 = trimmed.replace(/\s/g, '')
            if (trimmedForBase64.length > 50 && /^[A-Za-z0-9+/=]+$/.test(trimmedForBase64)) {
              masked[key] = `[base64_data_masked:${value.length}_chars]`
            } else {
              masked[key] = maskBase64InObject(value)
            }
          }
        } else {
          masked[key] = maskBase64InObject(value)
        }
      } else if (key === 'file_base64' || key === 'output') {
        // Check if output contains file_base64 (can be in function_call_output objects)
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value)
            if (parsed && typeof parsed === 'object') {
              // Recursively mask the parsed object to handle nested base64
              const maskedParsed = maskBase64InObject(parsed)
              masked[key] = JSON.stringify(maskedParsed)
            } else {
              masked[key] = maskBase64InObject(value)
            }
          } catch (e) {
            // Not JSON, check if it's a long base64 string itself
            if (value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value)) {
              masked[key] = `[base64_data_masked:${value.length}_chars]`
            } else {
              masked[key] = value
            }
          }
        } else {
          masked[key] = maskBase64InObject(value)
        }
      } else if (key === 'output_text') {
        // Handle output_text which may contain JSON strings with base64 data
        if (typeof value === 'string') {
          try {
            // Try to parse as JSON to mask base64 within it
            const parsed = JSON.parse(value)
            if (parsed && typeof parsed === 'object') {
              // Recursively mask the parsed object
              masked[key] = JSON.stringify(maskBase64InObject(parsed))
            } else {
              masked[key] = maskBase64InObject(value)
            }
          } catch (e) {
            // Not JSON, check if it's a long base64 string itself
            if (value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value)) {
              masked[key] = `[base64_data_masked:${value.length}_chars]`
            } else {
              masked[key] = value
            }
          }
        } else {
          masked[key] = maskBase64InObject(value)
        }
      } else {
        masked[key] = maskBase64InObject(value)
      }
    }
    return masked
  }
  return obj
}

class BotiumConnectorChatGPTResponsesAPI {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
    this.openai = null
    this.fileSendMode = null
    this.lastResponseId = null
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
    this.respondAsBotiumJson = this.caps[Capabilities.CHATGPT_RESPOND_AS_BOTIUM_JSON]
  }

  /**
   * Creates an Excel file from data and returns it as a base64 string
   * @param {Array} data - Array of arrays representing rows and columns
   * @param {string} sheetName - Name of the sheet (default: 'Sheet1')
   * @returns {string} Excel file base64 string
   */
  createExcelFile (data) {
    debug('[Excel] createExcelFile called')
    try {
      const worksheet = XLSX.utils.aoa_to_sheet(data)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
      // Convert workbook Buffer to base64 string
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
      const base64 = buffer.toString('base64')
      return base64
    } catch (error) {
      debug('[Excel] Error creating Excel file:', error?.message || error)
      throw new Error(`Failed to create Excel file: ${error?.message || error}`)
    }
  }

  /**
   * Gets the Excel creation tool definition for OpenAI Responses API
   * @returns {Object} Tool definition
   */
  getExcelCreationTool () {
    return {
      type: 'function',
      name: 'createExcelFile',
      description: 'Creates an Excel (.xlsx) file from tabular data. The function accepts data as an array of arrays (rows) and returns the file in base64 format.',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            description: 'Array of arrays representing rows and columns. First row can be headers.',
            items: {
              type: 'array',
              items: {
                oneOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' }
                ]
              }
            }
          }
        },
        required: ['data']
      }
    }
  }

  /**
   * Builds parameters for OpenAI Responses API call
   * @param {Array} input - The input conversation array
   * @returns {Object} Parameters object for API call
   */
  async callOpenAi (input) {
    debug(`OpenAI input: ${JSON.stringify(maskBase64InObject(input))}`)
    const params = {
      model: this.caps[Capabilities.CHATGPT_MODEL],
      instructions: (this.caps[Capabilities.CHATGPT_PROMPT] || '') + (this.respondAsBotiumJson ? BOTIUM_JSON_INSTRUCTIONS : ''),
      previous_response_id: this.lastResponseId,
      input: input
    }

    if (this.respondAsBotiumJson) {
      params.text = {
        format: {
          type: 'json_schema',
          name: 'botium_message',
          schema: BOTIUM_JSON_SCHEMA,
          strict: true
        }
      }
    }

    // Initialize tools array with Excel creation tool
    const tools = [this.getExcelCreationTool()]

    // Add any additional tools from capabilities
    if (!_.isNil(this.caps[Capabilities.CHATGPT_TOOLS])) {
      const additionalTools = this.caps[Capabilities.CHATGPT_TOOLS].split(',').map(tool => ({ type: tool.trim() }))
      tools.push(...additionalTools)
    }

    params.tools = tools

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

    debug(`OpenAI params: ${JSON.stringify(maskBase64InObject(params))}`)
    const result = await this.openai.responses.create(params)
    debug(`OpenAI response: ${JSON.stringify(maskBase64InObject(result))}`)

    // Update lastResponseId after successful API call
    if (result?.id) {
      this.lastResponseId = result.id
    }

    return result
  }

  /**
   * Processes tool outputs from response and extracts Excel files
   * @param {Object} response - The API response object
   * @returns {Object} Object containing excelMedia array and optional followUpResponse
   */
  async extractExcelFilesFromResponse (response) {
    let followUpResponse = null
    let excelAttachments = []

    try {
      // Check for function calls in response.output
      if (Array.isArray(response.output)) {
        const functionCalls = []
        const functionCallOutputs = []

        response.output.forEach((item) => {
          if (item.type === 'function_call') {
            debug('[Excel] Found function_call:', item.name)
            // Collect function calls to add to conversation
            functionCalls.push(item)

            if (item.name === 'createExcelFile') {
              debug('[Excel] Processing createExcelFile function call')
              try {
                // Execute the function logic for createExcelFile
                const args = typeof item.arguments === 'string'
                  ? JSON.parse(item.arguments)
                  : item.arguments

                const excelBase64 = this.createExcelFile(args.data)
                excelAttachments.push({
                  name: 'excel.xlsx',
                  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  base64: excelBase64
                })
                // Provide function call results to the model
                functionCallOutputs.push({
                  type: 'function_call_output',
                  call_id: item.call_id,
                  output: ''
                  // output: JSON.stringify({
                  //   file_base64: excelBase64
                  // })
                })
              } catch (error) {
                debug('[Excel] Error executing createExcelFile:', error?.message || error)
              }
            }
          }
        })

        // If we have function call outputs, make a follow-up API call
        if (functionCallOutputs.length > 0) {
          debug('[Excel] Making follow-up API call', { outputs: functionCallOutputs.length, responseId: response.id })

          // For Responses API with function calls:
          // - Use previous_response_id to reference the response containing function calls
          // - Only pass function call outputs in input array, not the full conversation
          const input = functionCallOutputs

          try {
            followUpResponse = await this.callOpenAi(input)
            // Reference the previous response that contains the function calls
          } catch (error) {
            debug('[Excel] Error in follow-up API call:', error?.message || error)
            throw error
          }
        } else {
          debug('[Excel] No function call outputs, skipping follow-up API call')
        }
      }
    } catch (error) {
      debug('[Excel] Error extracting Excel files from response:', error?.message || error)
    }

    debug('[Excel] extractExcelFilesFromResponse completed')
    return { followUpResponse, excelAttachments }
  }

  async Start () {
    debug('Start called')
    this.lastResponseId = null
  }

  async UserSays (msg) {
    debug(`UserSays called with message: ${JSON.stringify(maskBase64InObject(msg))}`)
    const uploadedFileIds = []
    const buildUserContent = async () => {
      const content = []
      if (msg.messageText) {
        content.push({ type: 'input_text', text: msg.messageText })
      }

      for (const a of (msg.media || [])) {
        const name = a.mediaUri || a?.altText || a?.name
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
            content.push({
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
              content.push({
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
          content.push({
            type: 'input_text',
            text: `File attachment (prepared, no need to download or read out)\nname:\n${name}\nContent:\n${textContent}`
          })
          debug(`Inline text attachment content: ${JSON.stringify(maskBase64InObject(content))}`)
        } else {
          debug(`Skipping attachment of file "${name}" type ${mimeType}`)
        }
      }

      // Return as message format for Responses API
      return [{
        type: 'message',
        role: 'user',
        content: content
      }]
    }

    const currentUserContent = await buildUserContent()

    try {
      debug(`Calling OpenAI with currentUserContent: ${JSON.stringify(maskBase64InObject(currentUserContent))}`)
      const response = await this.callOpenAi(currentUserContent)
      // Extract Excel files from response
      const { followUpResponse, excelAttachments } = await this.extractExcelFilesFromResponse(response)
      debug(`FollowUpResponse: ${JSON.stringify(maskBase64InObject(followUpResponse))}`)
      const responseToUse = followUpResponse || response

      let assistantText = ''
      let botiumJson = null

      if (responseToUse.output_text) {
        const outputText = responseToUse.output_text

        // If we're expecting Botium JSON, try to parse output_text as JSON first
        if (this.respondAsBotiumJson) {
          debug(`Parsing Openai Response as Botium JSON`)
          try {
            const parsed = JSON.parse(outputText)
            if (parsed && typeof parsed === 'object') {
              debug(`Parsed Openai Response as Botium JSON succesfully`)
              botiumJson = parsed
              assistantText = parsed.messageText || outputText
            } else {
              debug(`Parsed Openai Response as Botium JSON failed, fallback to assistantText`)
              assistantText = outputText
            }
          } catch (e) {
            debug(`Parsed Openai Response as Botium JSON failed with error: ${e?.message || e}, fallback to assistantText`)
            // Not JSON or parse failed, use as-is
            assistantText = outputText
          }
        } else {
          assistantText = outputText
          debug(`Botium format disabled, assistant text extracted: ${assistantText}`)
        }
      } else {
        debug('No output_text found in response')
      }

      if (assistantText || botiumJson) {
        const botMsg = {
          sender: 'bot',
          sourceData: maskBase64InObject(responseToUse)
        }
        if (botiumJson) {
          botMsg.messageText = botiumJson.messageText
          if (Array.isArray(botiumJson.buttons)) botMsg.buttons = botiumJson.buttons
          if (Array.isArray(botiumJson.media)) botMsg.media = botiumJson.media
          if (Array.isArray(botiumJson.attachments)) botMsg.attachments = botiumJson.attachments
          if (Array.isArray(botiumJson.cards)) botMsg.cards = botiumJson.cards
          if (!_.isNil(botiumJson.intent)) botMsg.intent = botiumJson.intent
        } else if (assistantText) {
          botMsg.messageText = assistantText
        }
        // it has no sense to get attachments from the response? It just makes the prompt longer, and
        // openai might change the base64 string?
        if (Array.isArray(excelAttachments)) botMsg.attachments = excelAttachments

        setTimeout(() => this.queueBotSays(botMsg), 0)
      } else {
        debug('[Debug] Not queuing message - no content found')
      }
    } catch (error) {
      debug(`error: ${JSON.stringify(maskBase64InObject(error))}`)
      debug('Error sending message to ChatGPT (Responses API):', error?.message || error)
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
    this.lastResponseId = null
  }

  async Clean () {
    debug('Clean called')
    this.openai = null
  }
}

module.exports = BotiumConnectorChatGPTResponsesAPI
