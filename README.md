# Botium Connector for ChatGPT (OpenAI Responses API)

This is a [Botium](https://github.com/codeforequity-at/botium-core) connector for testing your ChatGPT-based chatbots using the OpenAI Responses API.

__Read the [Botium in a Nutshell](https://medium.com/@floriantreml/botium-in-a-nutshell-part-1-overview-f8d0ceaf8fb4) articles first for best results.__

## How it works
Botium connects to the OpenAI Responses API and relays user messages to a specified ChatGPT model. It maintains a minimal conversation state and returns the assistant reply into Botium.

Works with:
- [Botium CLI](https://github.com/codeforequity-at/botium-cli/)
- [Botium Bindings](https://github.com/codeforequity-at/botium-bindings/)
- [Botium Box](https://www.botium.at)

## Requirements
- Node.js and npm
- An OpenAI API key with access to the chosen model

## Install

Using Botium CLI:

```
npm install -g botium-cli
npm install botium-connector-chatgpt --save-dev
botium-cli init
botium-cli run
```

Using Botium Bindings:

```
npm install --save-dev botium-bindings botium-connector-chatgpt
botium-bindings init mocha
npm install && npm run mocha
```

## Configuration
Create `botium.json`:

```json
{
  "botium": {
    "Capabilities": {
      "CONTAINERMODE": "chatgpt",
      "CHATGPT_API_KEY": "your-api-key",
      "CHATGPT_MODEL": "gpt-4o-mini",
      "CHATGPT_PROMPT": "You are a helpful assistant."
    }
  }
}
```

Then run the emulator to validate your config:

```
botium-cli emulator
```

## Supported Capabilities
- `CONTAINERMODE`: set to `chatgpt` to activate this connector
- `CHATGPT_API_KEY` (required): OpenAI API key
- `CHATGPT_MODEL` (required): model name, e.g. `gpt-4o-mini`
- `CHATGPT_PROMPT`: optional system prompt
- `CHATGPT_TEMPERATURE`: number
- `CHATGPT_MAX_TOKENS`: number, mapped to `max_output_tokens`
- `CHATGPT_REASONING_EFFORT`: string, passed as `reasoning.effort`

