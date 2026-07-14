export function declaredAgentType(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): string | undefined {
  if (env.ITPAY_AGENT_TYPE) return env.ITPAY_AGENT_TYPE;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--agent-type") return argv[index + 1];
    if (value?.startsWith("--agent-type=")) return value.slice("--agent-type=".length);
  }
  return undefined;
}

export function qualifyItPayCommand(command: string, agentType: string | undefined): string {
  if (!agentType || !/^[a-z0-9-]+$/.test(agentType)) return command;
  if (!command.startsWith("itpay ") || /^itpay\s+--agent-type(?:=|\s)/.test(command)) return command;
  return `itpay --agent-type ${agentType} ${command.slice("itpay ".length)}`;
}
