// The worker choices exposed by Chito. Values are passed directly to each CLI.
export const WORKER_MODELS = [
  { id: 'claude:opus', harness: 'claude', model: 'claude-opus-5-5', group: 'Claude Code', label: 'Opus 5.5' },
  { id: 'claude:sonnet', harness: 'claude', model: 'claude-sonnet-5-5', group: 'Claude Code', label: 'Sonnet 5.5' },
  { id: 'claude:haiku', harness: 'claude', model: 'claude-haiku-5-5', group: 'Claude Code', label: 'Haiku 5.5' },
  { id: 'claude:auto', harness: 'claude', model: 'default', group: 'Claude Code', label: 'Auto' },
  { id: 'pi:kimi', harness: 'pi', model: 'together/moonshotai/Kimi-K3.1-Pro', group: 'Pi', label: 'Kimi K3.1 Pro' },
  { id: 'pi:deepseek-pro', harness: 'pi', model: 'together/deepseek-ai/DeepSeek-V4-Pro-0813', group: 'Pi', label: 'DeepSeek V4 Pro' },
  { id: 'pi:deepseek-flash', harness: 'pi', model: 'together/deepseek-ai/DeepSeek-V4.1-Flash', group: 'Pi', label: 'DeepSeek V4.1 Flash' },
  { id: 'codex:sol', harness: 'codex', model: 'gpt-6.1-sol', group: 'Codex', label: 'Sol' },
  { id: 'codex:terra', harness: 'codex', model: 'gpt-6.1-terra', group: 'Codex', label: 'Terra' },
];

export const workerModel = id => WORKER_MODELS.find(choice => choice.id === id);
