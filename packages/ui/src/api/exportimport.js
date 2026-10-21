import client from './client'

const exportData = (body) => client.post('/export-import/export', body)
const downloadData = (body, signal) =>
    client.post('/export-import/export?download=true', body, { responseType: 'blob', ...(signal ? { signal } : {}) })
const streamData = (body, signal) =>
    client.post('/export-import/export?download=true', body, { adapter: 'fetch', responseType: 'stream', signal })
const importData = (body) => client.post('/export-import/import', body)
const exportChatflowMessages = (body) => client.post('/export-import/chatflow-messages', body)

export default {
    exportData,
    downloadData,
    streamData,
    importData,
    exportChatflowMessages
}
