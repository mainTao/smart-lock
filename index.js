let redis
const waitingQueue = []
const lockingMap = {}
const EventEmitter = require('events')
const emitter = new EventEmitter()
let seq = 0 // 序号生成器

let debug = () => { }

emitter.on('release', async (redisKey) => {
  debug('release', new Date)
  delete lockingMap[redisKey]
  let lock = pickOneFromQueue(redisKey) // 下一个锁去解锁
  if (lock) {
    if (await acquire(lock)) {// 得到了锁，从等待队列中删除
      removeFromWaitingQueue(lock)
    }
  }
})

emitter.on('expire', async (lock) => {
  debug('expire', lock.id)
  lock.reject(new AcquireLockError('expired'))
  removeFromWaitingQueue(lock)
})

function enQueue(lock) {
  debug('enQueue: ', lock.id)
  lock.waitTimer = setTimeout(() => {
    emitter.emit('expire', lock)
  }, lock.expireAt - Date.now())

  if (waitingQueue.length === 0) {
    waitingQueue.push(lock)
  }
  else{
    for (let i = waitingQueue.length - 1; i > 0; i--) {
      if (lock.id > waitingQueue[i].id) { // 找到所在的位置
        return waitingQueue.splice(i + 1, 0, lock) // 插在第一个比它小的元素后
      }
    }
    if (lock.id > waitingQueue[0].id) { // 与头元素比较
      waitingQueue.splice(1, 0, lock) // 比头元素大则插在后面
    }
    else{
      waitingQueue.splice(0, 0, lock) // 比头元素小则插在前面
    }
  }
}

async function acquire(lock) {
  let rs = await redis.set(lock.redisKey, lock.value, 'NX', 'PX', lock.maxTimeToLock)
  if (rs) { // got lock
    lockingMap[lock.redisKey] = lock
    lock.gotLockAt = Date.now()
    lock.resolve(lock)
    clearTimeout(lock.waitTimer)
    lock.releaseTimer = setTimeout(() => {
      emitter.emit('release', lock.redisKey)
    }, lock.maxTimeToLock)
    debug('acquire success', lock.id)
    return true
  }
  debug('acquire fail', lock.id)
  return false
}

function removeFromWaitingQueue(lock) {
  for (let i = 0; i < waitingQueue.length; i++) {
    if (waitingQueue[i].id === lock.id) {
      debug('remove: ', lock.id, 'length=', waitingQueue.length)
      clearTimeout(lock.waitTimer)
      waitingQueue.splice(i, 1)
      break
    }
  }
}

function pickOneFromQueue(redisKey) {
  for (let lock of waitingQueue) {
    if (lock.redisKey === redisKey && lock.expireAt > Date.now()) {
      debug(lock.id, waitingQueue[waitingQueue.length - 1].id)
      return lock
    }
  }
  return null
}

class AcquireLockError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AcquireLockError'
  }
}

class Lock {
  constructor(redisKey, maxTimeToWait, maxTimeToLock) {
    this.id = ++seq
    this.value = this.id + Math.random()
    this.redisKey = redisKey
    this.expireAt = Date.now() + maxTimeToWait
    this.maxTimeToLock = maxTimeToLock
  }

  async release() {
    return new Promise((resolve, reject) => {
      redis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, this.redisKey, this.value,
        err => {
          if (err) {
            reject(err)
          }
          clearTimeout(this.releaseTimer)
          emitter.emit('release', this.redisKey)
          resolve(this)
        })
    })
  }
}

function canAcquireLock(redisKey) {
  if(lockingMap[redisKey]){
    debug('lockingSet has', redisKey)
    return false
  }
  if(pickOneFromQueue(redisKey)){
    debug('waitingQueue has', redisKey)
    return false
  }
  return true
}

module.exports = (redisClient, options) => {
  redis = redisClient
  if (options && options.debug) {
    debug = console.log
  }

  return {
    AcquireLockError: AcquireLockError,
    acquireLock: async function (redisKey, maxTimeToWait = 0, maxTimeToLock = 10000) {
      return new Promise(async (resolve, reject) => {
        const lock = new Lock(redisKey, maxTimeToWait, maxTimeToLock)
        lock.resolve = resolve
        lock.reject = reject

        if (!canAcquireLock(redisKey)) { // 如果还有同名的锁，则到后面排队
          if (lock.expireAt <= Date.now()) { // 不愿等待的，立即返回失败
            reject(new AcquireLockError('Will not wait'))
          }
          else {
            enQueue(lock)
          }
        }
        else { // 若不需要排队则立刻申请锁
          if (!await acquire(lock)) { // acquire failed
            enQueue(lock) // 申请不到还是要排队的
          }
        }
      })
    },
    clear: () => {
      for(let lock of waitingQueue){
        clearTimeout(lock.waitTimer)
      }
      waitingQueue.splice(0, waitingQueue.length)

      for(let key in lockingMap){
        clearTimeout(lockingMap[key].releaseTimer)
        delete lockingMap[key]
      }

      seq = 0
    }
  }
}
