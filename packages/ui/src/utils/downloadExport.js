import exportImportApi from '@/api/exportimport'

// Call from the Export click handler: the file picker requires user activation.
export const downloadExport = async (body, { signal, onProgress = () => {} } = {}) => {
    if (typeof window.showSaveFilePicker === 'function') {
        let writable
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: 'ExportData.json',
                types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }]
            })
            signal?.throwIfAborted()
            writable = await handle.createWritable()
            signal?.throwIfAborted()
            const response = await exportImportApi.streamData(body, signal)
            let bytes = 0
            let lastProgress = 0
            const progress = new TransformStream({
                transform(chunk, controller) {
                    bytes += chunk.byteLength
                    if (Date.now() - lastProgress >= 250) {
                        onProgress(bytes)
                        lastProgress = Date.now()
                    }
                    controller.enqueue(chunk)
                }
            })
            // Backpressure reaches the HTTP reader. The file is committed only after
            // the complete response arrives; a failed download aborts the temporary file.
            await response.data.pipeThrough(progress).pipeTo(writable, { signal })
            onProgress(bytes)
            return
        } catch (error) {
            await writable?.abort().catch(() => {})
            throw error
        }
    }

    // Preserve downloads in browsers without the File System Access picker.
    const response = await exportImportApi.downloadData(body, signal)
    signal?.throwIfAborted()
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = 'ExportData.json'
    document.body.appendChild(link)
    try {
        link.click()
    } finally {
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
    }
}
