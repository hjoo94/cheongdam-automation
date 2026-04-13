const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminApi', {
  loadAdminConfig: () => ipcRenderer.invoke('load-admin-config'),
  saveAdminConfig: (data) => ipcRenderer.invoke('save-admin-config', data),
  checkAdminServer: (data) => ipcRenderer.invoke('check-admin-server', data),
  createLicense: (data) => ipcRenderer.invoke('create-license', data),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  toggleLicenseEnabled: (licenseKey, isEnabled) =>
    ipcRenderer.invoke('toggle-license-enabled', { licenseKey, isEnabled }),
  extendLicenseDays: (licenseKey, days) =>
    ipcRenderer.invoke('extend-license-days', { licenseKey, days }),
  deleteLicense: (licenseKey) => ipcRenderer.invoke('delete-license', { licenseKey }),
  checkUpdate: () => ipcRenderer.invoke('check-admin-update'),
  onUpdateStatus: (callback) => ipcRenderer.on('admin-update-status', (_, message) => callback(message)),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
});
