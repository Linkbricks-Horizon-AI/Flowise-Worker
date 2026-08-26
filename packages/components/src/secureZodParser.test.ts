import { SecureZodSchemaParser } from './secureZodParser'

describe('SecureZodSchemaParser', () => {
    it('parses description strings that contain URL slashes and dots', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                imageUrl: z.string().describe("Default value is http://wwww.xxx.com/ddd.jpg")
            })
        `) as any

        expect(schema.shape.imageUrl.description).toBe('Default value is http://wwww.xxx.com/ddd.jpg')
        expect(schema.parse({ imageUrl: 'https://example.com/image.jpg' })).toEqual({ imageUrl: 'https://example.com/image.jpg' })
    })

    it('keeps URLs inside strings while removing actual comments', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                // This comment should be ignored.
                imageUrl: z.string().describe("Use https://example.com/assets/a.b.jpg") // trailing comment
            })
        `) as any

        expect(schema.shape.imageUrl.description).toBe('Use https://example.com/assets/a.b.jpg')
    })

    it('parses default string values that contain URL punctuation', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                imageUrl: z.string().default("http://wwww.xxx.com/ddd.jpg")
            })
        `) as any

        expect(schema.parse({})).toEqual({ imageUrl: 'http://wwww.xxx.com/ddd.jpg' })
    })

    it('parses default(false) as boolean so omitting the field still validates', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                query: z.string(),
                full_auto: z.boolean().default(false)
            })
        `) as any

        expect(schema.parse({ query: 'q' })).toEqual({ query: 'q', full_auto: false })
        expect(schema.parse({ query: 'q', full_auto: true })).toEqual({ query: 'q', full_auto: true })
    })

    it('parses default(true) as boolean true', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                flag: z.boolean().default(true)
            })
        `) as any

        expect(schema.parse({})).toEqual({ flag: true })
    })

    it('keeps quoted "false" as a string default', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                mode: z.string().default("false")
            })
        `) as any

        expect(schema.parse({})).toEqual({ mode: 'false' })
    })

    it('parses boolean default chained with describe', () => {
        const schema = SecureZodSchemaParser.parseZodSchema(`
            z.object({
                full_auto: z.boolean().default(false).describe("Always pass exactly false. Never pass true.")
            })
        `) as any

        expect(schema.parse({})).toEqual({ full_auto: false })
        expect(schema.shape.full_auto.description).toBe('Always pass exactly false. Never pass true.')
    })

    it('parses bare boolean literals in multi-argument lists (parity with the single-argument path)', () => {
        // Single bare literals take the fast path; multi-argument lists go through
        // splitArguments. Both must agree on literal types, and quoted booleans must
        // stay strings on both paths.
        const args = (SecureZodSchemaParser as any).parseArguments('(1, true, false, "true")')

        expect(args).toEqual([1, true, false, 'true'])
    })
})
