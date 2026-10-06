import { NodesPool } from './NodesPool'

jest.mock('./utils', () => ({ getNodeModulesPackagePath: () => '/virtual' }))
jest.mock('./utils/logger', () => ({ error: jest.fn() }))
jest.mock('./AppConfig', () => ({ appConfig: { showCommunityNodes: true } }))
jest.mock('../../components/src/utils', () => ({}))
jest.mock('/virtual/ChatflowTool/ChatflowTool.js', () => require('../../components/nodes/tools/ChatflowTool/ChatflowTool'), {
    virtual: true
})
jest.mock(
    '/virtual/VoraChatflowTool/VoraChatflowTool.js',
    () => require('../../components/nodes/tools/VoraChatflowTool/VoraChatflowTool'),
    { virtual: true }
)
jest.mock('/virtual/credentials/ChatflowApi.credential.js', () => require('../../components/credentials/ChatflowApi.credential'), {
    virtual: true
})

describe('Vora node registration alongside the original Chatflow Tool', () => {
    const files = ['/virtual/ChatflowTool/ChatflowTool.js', '/virtual/VoraChatflowTool/VoraChatflowTool.js']

    it.each([false, true])('keeps both nodes and the original credential icon, reverse loading=%s', async (reverse) => {
        const pool = new NodesPool()
        jest.spyOn(pool as any, 'getFiles').mockImplementation(async (...args: any[]) =>
            args[0].endsWith('credentials') ? ['/virtual/credentials/ChatflowApi.credential.js'] : reverse ? [...files].reverse() : files
        )
        await pool.initialize()
        expect(Object.keys(pool.componentNodes).sort()).toEqual(['ChatflowTool', 'VoraChatflowTool'])
        expect(pool.componentNodes.VoraChatflowTool).toMatchObject({
            label: 'Vora Chatflow Tool',
            name: 'VoraChatflowTool',
            type: 'VoraChatflowTool',
            version: 1,
            category: 'Tools',
            baseClasses: ['VoraChatflowTool', 'Tool'],
            icon: '/virtual/VoraChatflowTool/voraRouter.png'
        })
        expect(pool.componentNodes.ChatflowTool).toMatchObject({
            label: 'Chatflow Tool',
            version: 5.1,
            icon: '/virtual/ChatflowTool/chatflowTool.svg'
        })
        expect(pool.componentCredentials.chatflowApi.icon).toBe('/virtual/ChatflowTool/chatflowTool.svg')
        const fields = pool.componentNodes.VoraChatflowTool.inputs!
        expect(fields.find((field) => field.name === 'toolEnabled')).toMatchObject({ default: true, type: 'boolean' })
        expect(fields.some((field) => field.name === 'user_id' || field.name === 'tool_usage')).toBe(false)
    })
})
