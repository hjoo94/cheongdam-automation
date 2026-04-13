const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'save-settings',
  'load-settings',
  'check-server-connection',
  'check-app-update',
  'get-review-analysis',
  'prepare-bot',
  'start-bot',
  'stop-bot',
  'pick-idcard',
  'pick-finance-file',
  'pick-finance-deposit-files',
  'pick-finance-withdrawal-files',
  'analyze-finance-file',
  'analyze-store-click',
  'analyze-threads-marketing',
  'open-threads-mosaic-folder',
  'open-log-folder',
  'summarize-error-logs',
  'reset-coupang',
  'save-license',
  'load-license',
  'verify-license',
]);

const SEND_CHANNELS = new Set(['open-support']);
const RECEIVE_CHANNELS = new Set(['log']);

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked IPC invoke channel: ${channel}`);
  }
  return ipcRenderer.invoke(channel, payload);
}

function send(channel, payload) {
  if (!SEND_CHANNELS.has(channel)) {
    throw new Error(`Blocked IPC send channel: ${channel}`);
  }
  ipcRenderer.send(channel, payload);
}

function on(channel, callback) {
  if (!RECEIVE_CHANNELS.has(channel)) {
    throw new Error(`Blocked IPC receive channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new Error('IPC listener callback must be a function.');
  }

  const listener = (_, message) => callback(String(message || ''));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', Object.freeze({
  saveSettings: (data) => invoke('save-settings', data),
  loadSettings: () => invoke('load-settings'),
  checkServerConnection: (data) => invoke('check-server-connection', data),
  checkUpdate: () => invoke('check-app-update'),
  getReviewAnalysis: () => invoke('get-review-analysis'),
  prepareBot: (data) => invoke('prepare-bot', data),
  startBot: () => invoke('start-bot'),
  stopBot: () => invoke('stop-bot'),
  pickIdCard: () => invoke('pick-idcard'),
  pickFinanceFile: () => invoke('pick-finance-file'),
  pickFinanceDepositFiles: () => invoke('pick-finance-deposit-files'),
  pickFinanceWithdrawalFiles: () => invoke('pick-finance-withdrawal-files'),
  analyzeFinanceFile: (data) => invoke('analyze-finance-file', data),
  analyzeStoreClick: (data) => invoke('analyze-store-click', data),
  analyzeThreadsMarketing: (data) => invoke('analyze-threads-marketing', data),
  openThreadsMosaicFolder: () => invoke('open-threads-mosaic-folder'),
  openSupport: () => send('open-support'),
  openLogFolder: () => invoke('open-log-folder'),
  summarizeErrorLogs: () => invoke('summarize-error-logs'),
  resetCoupang: () => invoke('reset-coupang'),
  onLog: (callback) => on('log', callback),
  saveLicense: (data) => invoke('save-license', data),
  loadLicense: () => invoke('load-license'),
  verifyLicense: (data) => invoke('verify-license', data),
}));
