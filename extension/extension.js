const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

function activate(ctx) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'showContext.refresh';
  item.show();
  const script = path.join(__dirname, 'ctx.py');
  const update = () => {
    cp.execFile('python', ['-I', script], { timeout: 8000 }, (err, out) => {
      let r = {};
      try { r = JSON.parse(out); } catch {}
      if (!r.used) { item.text = '$(pulse) Ctx: n/a'; item.tooltip = 'No Antigravity conversation found'; return; }
      const pct = Math.round(r.used / r.limit * 100);
      const k = n => (n / 1000).toFixed(1) + 'k';
      item.text = `$(pulse) Ctx ${k(r.used)}/${k(r.limit)} (${pct}%)`;
      item.tooltip = `Conversation ${r.id}\nClick to refresh`;
      item.color = pct >= 90 ? new vscode.ThemeColor('errorForeground') : pct >= 70 ? new vscode.ThemeColor('editorWarning.foreground') : undefined;
    });
  };
  ctx.subscriptions.push(item, vscode.commands.registerCommand('showContext.refresh', update));
  const t = setInterval(update, 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(t) });
  update();
}
exports.activate = activate;
