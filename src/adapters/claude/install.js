function managedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function installPlan(root, home) {
  const base = `${home}/.claude/skills/asterism`;
  const managed = 'asterism managed file -- removed by ast uninstall';
  const plugin = Object.freeze({
    targetPath: `${base}/.claude-plugin/plugin.json`,
    content: managedJson({
      $comment: managed,
      name: 'asterism',
      description: 'agent session cockpit hooks',
    }),
  });
  const hooks = Object.freeze({
    targetPath: `${base}/hooks/hooks.json`,
    content: managedJson({
      $comment: managed,
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: `${root}/bin/ast-hook claude session-start` }],
          },
        ],
        Notification: [
          {
            hooks: [{ type: 'command', command: `${root}/bin/ast-hook claude notification` }],
          },
        ],
      },
    }),
  });
  return Object.freeze([plugin, hooks]);
}

export const installSupport = Object.freeze({ installPlan });
