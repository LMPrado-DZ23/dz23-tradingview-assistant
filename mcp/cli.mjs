// DZ23 MCP CLI — inspect and call an MCP server through the same registry, policy and audit as the copilot.
//
//   node mcp/cli.mjs list --url http://127.0.0.1:9000 --token-env MCP_TOKEN
//   node mcp/cli.mjs call --url ... --token-env MCP_TOKEN --tool quote --arg symbol=BTCUSDT [--confirm]
import { createClient, createRegistry, callGated } from './core.mjs'

const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let index = 0; index < rest.length; index++) {
  const token = rest[index]
  if (!token.startsWith('--'))
    continue
  const name = token.slice(2)
  if (name === 'confirm') { args.confirm = true; continue }
  const value = rest[index + 1]
  if (value === undefined || value.startsWith('--'))
    throw new Error(`--${name} needs a value`)
  args[name] = value
  index += 1
}
if (!args.url)
  throw new Error('usage: node mcp/cli.mjs <list|call> --url URL [--token-env VAR] [--tool NAME] [--arg k=v] [--confirm]')

const registry = createRegistry([{
  name: 'cli',
  url: args.url,
  token: process.env[args['token-env'] ?? ''] ?? '',
  tokenEnv: args['token-env'] ?? null,
  allowedTools: args.tool ? [args.tool] : ['*'],
  policies: args.tool ? { [args.tool]: args.confirm ? 'allow' : 'ask' } : {},
}])

if (command === 'list') {
  const client = createClient(registry.get('cli'))
  const init = await client.initialize()
  const tools = await client.listTools()
  console.log(JSON.stringify({ server: init.serverInfo ?? null, tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })) }, null, 2))
} else if (command === 'call') {
  if (!args.tool)
    throw new Error('call needs --tool')
  const callArgs = {}
  for (const pair of String(args.arg ?? '').split(',').filter(Boolean)) {
    const [key, ...value] = pair.split('=')
    callArgs[key.trim()] = value.join('=').trim()
  }
  const result = await callGated(registry, { server: 'cli', tool: args.tool, arguments: callArgs, confirmed: Boolean(args.confirm) }, { log: (entry) => console.error(JSON.stringify(entry)) })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
} else {
  throw new Error(`unknown command "${command}" (expected list or call)`)
}
