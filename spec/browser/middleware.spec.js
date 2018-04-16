import forge, { setContext, configs } from 'src/mappersmith'
import Request from 'src/request'
import Response from 'src/response'

import {
  headerMiddleware,
  countMiddleware,
  getCountMiddlewareCurrent,
  getCountMiddlewareStack,
  resetCountMiddleware,
  getManifest
} from 'spec/helper'

describe('ClientBuilder middleware', () => {
  let manifest,
    gatewayInstance,
    response,
    responseValue

  const createClient = () => forge(manifest)

  beforeEach(() => {
    responseValue = 'success'
    manifest = getManifest()

    gatewayInstance = { call: jest.fn() }
    configs.gateway = jest.fn((request) => {
      response = new Response(request, 200, responseValue)
      gatewayInstance.call.mockReturnValue(Promise.resolve(response))
      return gatewayInstance
    })

    manifest.middleware = [ headerMiddleware ]
  })

  afterEach(() => resetCountMiddleware())

  it('receives an object with "resourceName", "resourceMethod" and empty "context"', async () => {
    const middleware = jest.fn()
    manifest.middleware = [ middleware ]

    await createClient().User.byId({ id: 1 })
    expect(middleware).toHaveBeenCalledWith(expect.objectContaining({
      resourceName: 'User',
      resourceMethod: 'byId',
      context: {},
      clientId: null
    }))
  })

  it('receives a clientId if present in manifest', async () => {
    const middleware = jest.fn()
    const manifest = getManifest([middleware], null, 'someClient')
    const client = forge(manifest)

    await client.User.byId({ id: 1 })
    expect(middleware).toBeCalledWith(expect.objectContaining({ clientId: 'someClient' }))
  })

  it('receives current context', async () => {
    const middleware = jest.fn()
    manifest.middleware = [ middleware ]

    const client = createClient()

    setContext({ foo: 'bar' })
    await client.User.byId({ id: 1 })

    expect(middleware).toBeCalledWith(expect.objectContaining({ context: { foo: 'bar' } }))

    const client2 = createClient()
    await client2.User.byId({ id: 1 })
    expect(middleware).lastCalledWith(expect.objectContaining({ context: { foo: 'bar' } }))
    expect(middleware).toHaveBeenCalledTimes(2)

    setContext({ foo: 'baz' })
    await client.User.byId({ id: 1 })
    expect(middleware).toBeCalledWith(expect.objectContaining({ context: { foo: 'baz' } }))
  })

  it('calls request and response phase', async () => {
    const requestPhase = jest.fn()
    const responsePhase = jest.fn(() => Promise.resolve())

    const middleware = () => ({ request: requestPhase, response: responsePhase })
    manifest.middleware = [ middleware ]

    await createClient().User.byId({ id: 1 })
    expect(requestPhase).toHaveBeenCalledWith(expect.any(Request))
    expect(responsePhase).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
  })

  it('can change the final request object', async () => {
    const response = await createClient().User.byId({ id: 1 })
    expect(response.request().headers()).toEqual(
      expect.objectContaining({ 'x-middleware-phase': 'request' })
    )
  })

  it('can change the final response object', async () => {
    const response = await createClient().User.byId({ id: 1 })
    expect(response.headers()).toEqual(
      expect.objectContaining({ 'x-middleware-phase': 'response' })
    )
  })

  it('calls all middleware chainning the "next" function', async () => {
    responseValue = getCountMiddlewareCurrent()

    manifest.middleware = [
      countMiddleware,
      countMiddleware,
      countMiddleware,
      countMiddleware
    ]

    const response = await createClient().User.byId({ id: 1 })
    expect(response.data()).toEqual(4)
    expect(getCountMiddlewareStack()).toEqual([0, 1, 2, 3])
  })

  it('accepts middleware with only one phase defined', async () => {
    let m1RequestCalled = false
    let m2ResponseCalled = false

    const m1 = () => ({
      request: (request) => { m1RequestCalled = true; return request }
    })

    const m2 = () => ({
      response: (next) => { m2ResponseCalled = true; return next() }
    })

    manifest.middleware = [ m1, m2 ]

    const response = await createClient().User.byId({ id: 1 })
    expect(response.data()).toEqual(responseValue)
    expect(m1RequestCalled).toEqual(true)
    expect(m2ResponseCalled).toEqual(true)
  })

  it('accepts async request phase', async () => {
    const m1 = () => ({
      request: (request) => Promise.resolve(request.enhance({
        headers: { token: 'abc' }
      }))
    })

    manifest.middleware = [ m1 ]

    const response = await createClient().User.byId({ id: 1 })
    expect(response.request().headers()).toEqual(expect.objectContaining({ token: 'abc' }))
  })

  it('can renew the request from the response phase', async () => {
    let token = 'not-renewed'
    const m1 = () => ({
      request: (request) => request.enhance({ headers: { 'Token': token } })
    })

    const m2 = () => ({
      response: (next, renew) => {
        return next().then((response) => {
          if (response.request().header('token') === 'not-renewed') {
            token = 'renewed'
            return renew()
          }

          return response
        })
      }
    })

    manifest.middleware = [ m1, m2 ]

    const response = await createClient().User.byId({ id: 1 })
    expect(response.request().header('token')).toEqual('renewed')
  })

  it('prevents renew to cause infinite loops', async () => {
    let executionCount = 0
    const m1 = () => ({
      response: (next, renew) => {
        executionCount++
        return executionCount < 5 ? renew() : next()
      }
    })

    manifest.middleware = [ m1 ]

    await expect(createClient().User.byId({ id: 1 })).rejects.toHaveProperty(
      'message',
      '[Mappersmith] infinite loop detected (middleware stack invoked 3 times). Check the use of "renew" in one of the middleware.'
    )
  })
})
