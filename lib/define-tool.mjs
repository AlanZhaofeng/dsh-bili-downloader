/**
 * defineTool 的本地实现（不 import @deepseek-ai/dsh-tools）。
 *
 * 为什么不用宿主那份：它在桌面版 profile 里是 **optional peer**，profile 树里不一定装；
 * 裸 import 一旦失败，整条插件不激活（方案坑清单 #6，实测过）。
 * 这里做的只有三件事，跟宿主 defineTool 的行为对齐：
 *   ① 参数规格（{ path: { type, required: true } }）→ JSON Schema
 *   ② 输出声明保持 JSON Schema，并检查 object 有没有写 additionalProperties（坑 #5）
 *   ③ 执行前按 schema 校验参数，非法参数报错而不是带着脏参数往下跑
 */

function valueSchema(spec, where) {
  if (!spec || typeof spec !== 'object') throw new Error(`defineTool: ${where} 不是合法的 schema`)
  const { required, ...rest } = spec
  const out = { ...rest }
  // 参数规格里 required 是布尔注解；输出 schema 里 required 是字段名数组，必须保留
  if (Array.isArray(required)) out.required = required
  if (out.type === 'object') {
    if (out.additionalProperties === undefined) {
      throw new Error(`defineTool: ${where} 是 object 却没写 additionalProperties`)
    }
    const properties = {}
    for (const [key, child] of Object.entries(out.properties || {})) {
      properties[key] = valueSchema(child, `${where}.properties.${key}`)
    }
    return { ...out, properties }
  }
  if (out.type === 'array' && out.items) return { ...out, items: valueSchema(out.items, `${where}.items`) }
  if (out.oneOf) return { ...out, oneOf: out.oneOf.map((child, i) => valueSchema(child, `${where}.oneOf[${i}]`)) }
  return out
}

export function parameterSchema(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    if (!spec || typeof spec !== 'object') throw new Error(`defineTool: 参数 ${key} 不是合法的 schema`)
    const { required: isRequired, ...rest } = spec
    properties[key] = valueSchema(rest, `parameters.${key}`)
    if (isRequired === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(schema, value) {
  const type = schema.type
  if (!type) return true
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  return actual === type
}

/** 极简校验：类型 / required / enum / 额外字段。返回违规说明数组。 */
export function validate(schema, value, path = '') {
  const violations = []
  if (!matchesType(schema, value)) {
    violations.push(`${path || '(根)'} 应为 ${schema.type}，实际是 ${typeOf(value)}`)
    return violations
  }
  if (schema.enum && !schema.enum.includes(value)) {
    violations.push(`${path || '(根)'} 只能是 ${schema.enum.join(' / ')}`)
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const key of schema.required || []) {
      if (value[key] === undefined) violations.push(`缺少必填参数 ${path ? path + '.' : ''}${key}`)
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key]
      if (!childSchema) {
        if (schema.additionalProperties === false) violations.push(`多了一个不认识的参数 ${path ? path + '.' : ''}${key}`)
        continue
      }
      violations.push(...validate(childSchema, child, path ? `${path}.${key}` : key))
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => violations.push(...validate(schema.items, item, `${path}[${index}]`)))
  }
  return violations
}

export function defineTool(options) {
  if (!options?.name) throw new Error('defineTool: 缺少 name')
  if (!options.output?.schema) throw new Error(`defineTool(${options.name}): 缺少 output.schema`)
  if (typeof options.output.render !== 'function') throw new Error(`defineTool(${options.name}): 缺少 output.render`)
  const parameters = parameterSchema(options.parameters)
  const outputSchema = valueSchema(options.output.schema, 'output.schema')

  const definition = {
    name: options.name,
    description: options.description || '',
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      const violations = validate(parameters, args)
      if (violations.length) {
        const error = new Error(`参数不合法：${violations.join('；')}`)
        error.code = 'INVALID_ARGS'
        throw error
      }
      return options.execute(args, exec)
    },
  }
  return definition
}
