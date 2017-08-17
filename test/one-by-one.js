const Promise = require('bluebird')
const Redis = require('ioredis')
const redis = new Redis({keyPrefix: 'user:'})
const redisKey = 'resourceName'
const _ = require('lodash')
const expect = require('chai').expect;
const assert = require('chai').assert;

const smartLock = require('../index')(redis, {debug: true})

async function task(timeToWait, duration) {
  let lock = await smartLock.acquireLock(redisKey, timeToWait)
  await Promise.delay(duration)
  await lock.release()
}

async function demo() {
  task(1000, 1000)
  task(1000, 1000)
  task(2000, 1000)
  task(3000, 1000)
  // await Promise.delay(2000)
}

// demo()


describe('排队测试', function () {
  beforeEach('clear redis', async () => {
    await redis.del(redisKey)
    smartLock.clear()
  })

  it('后面的锁不愿等，请求锁失败', async function () {
    try {
      await smartLock.acquireLock(redisKey)
      await smartLock.acquireLock(redisKey)
    }
    catch (e) {
      expect(e).to.be.an.instanceof(smartLock.AcquireLockError)
    }
  })

  it('后面的愿意等待，成功等到锁', async function () {
    let lock1 = await smartLock.acquireLock(redisKey)
    setTimeout(() => {
      lock1.release()
    }, 1000)

    await smartLock.acquireLock(redisKey, 1100)
  })

  it('后面的愿意等待，但等待超时', async function () {
    let lock1 = await smartLock.acquireLock(redisKey)
    setTimeout(() => {
      lock1.release()
    }, 1000)

    try {
      smartLock.acquireLock(redisKey, 900)
    }
    catch (e) {
      expect(e).to.be.an.instanceof(smartLock.AcquireLockError)
    }
  })

  it.only('申请到锁严格按照入队次序', async function () {
    let promises = []
    let lockIds = []
    let expectedIds = _.range(1, 101) // 1...100

    for (let i = 0; i < 100; i++) {
      let promise = smartLock.acquireLock(redisKey, 5000)
        .then(lock => {
          lockIds.push(lock.id)
          return lock.release()
        })
      promises.push(promise)
    }

    return Promise.all(promises)
      .then(() => {
        assert.deepEqual(lockIds, expectedIds)
      })
  })

})
