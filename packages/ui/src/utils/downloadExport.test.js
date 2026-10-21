jest.mock('@/api/exportimport', () => ({ __esModule: true, default: { streamData: jest.fn(), downloadData: jest.fn() } }))

import api from '@/api/exportimport'
import { downloadExport } from './downloadExport'

describe('workspace backup file saving', () => {
    let close
    let abort
    let write
    let picker
    let writable

    beforeEach(() => {
        jest.clearAllMocks()
        close = jest.fn()
        abort = jest.fn()
        write = jest.fn()
        writable = new WritableStream({ write: (chunk) => write(chunk), close, abort })
        picker = jest.fn().mockResolvedValue({ createWritable: jest.fn().mockResolvedValue(writable) })
        global.window = { showSaveFilePicker: picker }
    })

    afterEach(() => {
        delete global.window
        delete global.document
        jest.restoreAllMocks()
        jest.useRealTimers()
    })

    it('writes Unicode JSON incrementally and commits only after completion', async () => {
        const bytes = new TextEncoder().encode('{"ChatMessage":[{"content":"한국어 😀"}]}')
        api.streamData.mockResolvedValue({
            data: new ReadableStream({
                start(controller) {
                    controller.enqueue(bytes.subarray(0, 17))
                    controller.enqueue(bytes.subarray(17))
                    controller.close()
                }
            })
        })
        const onProgress = jest.fn()
        const signal = new AbortController().signal
        await downloadExport({ chat_message: true }, { signal, onProgress })
        expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'ExportData.json' }))
        expect(api.streamData).toHaveBeenCalledWith({ chat_message: true }, signal)
        expect(Buffer.concat(write.mock.calls.map(([chunk]) => Buffer.from(chunk))).toString()).toBe(new TextDecoder().decode(bytes))
        expect(close).toHaveBeenCalledTimes(1)
        expect(abort).not.toHaveBeenCalled()
        expect(onProgress).toHaveBeenLastCalledWith(bytes.byteLength)
        expect(api.downloadData).not.toHaveBeenCalled()
    })

    it('handles more than 1.3 GiB without collecting the response into a Blob', async () => {
        const chunk = new Uint8Array(1024 * 1024)
        let remaining = 1400
        let bytes = 0
        write.mockImplementation((value) => {
            bytes += value.byteLength
        })
        api.streamData.mockResolvedValue({
            data: new ReadableStream({
                pull(controller) {
                    if (remaining--) controller.enqueue(chunk)
                    else controller.close()
                }
            })
        })
        await downloadExport({ chat_message: true })
        expect(bytes).toBe(1400 * 1024 * 1024)
        expect(close).toHaveBeenCalledTimes(1)
        expect(api.downloadData).not.toHaveBeenCalled()
    })

    it('does not start a request when the save picker is cancelled', async () => {
        const error = new DOMException('Cancelled', 'AbortError')
        picker.mockRejectedValue(error)
        await expect(downloadExport({ chat_message: true })).rejects.toBe(error)
        expect(api.streamData).not.toHaveBeenCalled()
        expect(api.downloadData).not.toHaveBeenCalled()
    })

    it('aborts the temporary file when the server fails before returning a stream', async () => {
        api.streamData.mockRejectedValue(new Error('Permission denied'))
        await expect(downloadExport({ chat_message: true })).rejects.toThrow('Permission denied')
        expect(abort).toHaveBeenCalledTimes(1)
        expect(close).not.toHaveBeenCalled()
    })

    it('never commits a truncated response after a network failure', async () => {
        let reads = 0
        api.streamData.mockResolvedValue({
            data: new ReadableStream({
                pull(controller) {
                    if (!reads++) controller.enqueue(new TextEncoder().encode('{"ChatMessage":['))
                    else controller.error(new Error('Connection lost'))
                }
            })
        })
        await expect(downloadExport({ chat_message: true })).rejects.toThrow('Connection lost')
        expect(abort).toHaveBeenCalledTimes(1)
        expect(close).not.toHaveBeenCalled()
    })

    it('cancels the reader when the disk write fails', async () => {
        const cancel = jest.fn()
        write.mockRejectedValue(new Error('Disk full'))
        api.streamData.mockResolvedValue({
            data: new ReadableStream({
                pull(controller) {
                    controller.enqueue(new Uint8Array(1024))
                },
                cancel
            })
        })
        await expect(downloadExport({ chat_message: true })).rejects.toThrow('Disk full')
        expect(cancel).toHaveBeenCalled()
        expect(close).not.toHaveBeenCalled()
    })

    it('cancels the network reader and temporary file on user cancellation', async () => {
        const controller = new AbortController()
        const cancel = jest.fn()
        write.mockImplementationOnce(() => controller.abort())
        api.streamData.mockResolvedValue({
            data: new ReadableStream({
                pull(stream) {
                    stream.enqueue(new Uint8Array(1024))
                },
                cancel
            })
        })
        await expect(downloadExport({ chat_message: true }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
        expect(cancel).toHaveBeenCalled()
        expect(abort).toHaveBeenCalled()
        expect(close).not.toHaveBeenCalled()
    })

    it('keeps the existing download behavior when the file picker is unavailable', async () => {
        jest.useFakeTimers()
        global.window = {}
        const link = { click: jest.fn(), remove: jest.fn() }
        global.document = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } }
        jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup')
        jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const blob = new Blob(['{}'])
        const signal = new AbortController().signal
        api.downloadData.mockResolvedValue({ data: blob })
        await downloadExport({ chatflow: true }, { signal })
        expect(api.downloadData).toHaveBeenCalledWith({ chatflow: true }, signal)
        expect(link.download).toBe('ExportData.json')
        expect(link.click).toHaveBeenCalledTimes(1)
        expect(link.remove).toHaveBeenCalledTimes(1)
        jest.runAllTimers()
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:backup')
    })
})
