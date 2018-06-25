import omit from 'lodash.omit'
// Components
import CMeteorData from './components/MeteorData'
import CMeteorSub from './components/MeteorSub'

function defaultSubscription (...args) {
  return Meteor.subscribe(...args)
}

function hasProperty (holder, key) {
  return typeof holder !== 'undefined' && holder.hasOwnProperty(key)
}

const noop = () => {}

let set

export default {
  install (Vue, options) {
    const isServer = Vue.prototype.$isServer
    const vueVersion = Vue.version.substr(0, Vue.version.indexOf('.'))

    Vue.config.meteor = {
      subscribe: defaultSubscription,
      freeze: false,
    }

    set = Vue.set

    for (const k in options) {
      Vue.config.meteor[k] = options[k]
    }

    const merge = Vue.config.optionMergeStrategies.methods
    Vue.config.optionMergeStrategies.meteor = function (toVal, fromVal, vm) {
      if (!toVal) return fromVal
      if (!fromVal) return toVal

      const toData = Object.assign({}, omit(toVal, [
        'subscribe',
        'data',
      ]), toVal.data)
      const fromData = Object.assign({}, omit(fromVal, [
        'subscribe',
        'data',
      ]), fromVal.data)

      return Object.assign({
        subscribe: merge(toVal.subscribe, fromVal.subscribe),
      }, merge(toData, fromData))
    }

    function getResult (result) {
      if (result && typeof result.fetch === 'function') {
        result = result.fetch()
      }
      if (Vue.config.meteor.freeze) {
        result = Object.freeze(result)
      }
      return result
    }

    function prepare () {
      this._trackerHandles = []
      this._subsAutorun = {}
      this._subs = {}

      Object.defineProperty(this, '$subReady', {
        get: () => this.$data.$meteor.subs,
        enumerable: true,
        configurable: true,
      })
    }

    function launch () {
      this._meteorActive = true

      let meteor = this.$options.meteor

      if (meteor) {
        let ssr = true
        if (typeof meteor.$ssr !== 'undefined') {
          ssr = meteor.$ssr
        }

        if (!isServer || ssr) {
          // Subscriptions
          if (meteor.$subscribe) {
            for (let key in meteor.$subscribe) {
              this.$subscribe(key, meteor.$subscribe[key])
            }
          }

          // Reactive data
          for (let key in meteor) {
            if (key.charAt(0) !== '$') {
              this.$addMeteorData(key, meteor[key])
            }
          }
        }
      }
    }

    Vue.mixin({
      data () {
        return {
          $meteor: {
            data: {},
            subs: {},
          },
        }
      },

      ...vueVersion === '1' ? {
        init: prepare,
      } : {},

      ...vueVersion === '2' ? {
        beforeCreate: prepare,
      } : {},

      created () {
        if (this.$options.meteor && !this.$options.meteor.$lazy) {
          launch.call(this)
        }

        // Computed props
        const computed = this._computedWatchers
        if (computed) {
          for (let key in computed) {
            this.$addComputed(key, computed[key])
          }
        }
      },

      destroyed: function () {
        this.$stopMeteor()
      },

      methods: {
        $_subscribe (...args) {
          if (args.length > 0) {
            const key = args[0]
            const oldSub = this._subs[key]
            let handle = Vue.config.meteor.subscribe.apply(this, args)
            this._trackerHandles.push(handle)
            this._subs[key] = handle

            // Readiness
            if (typeof handle.ready === 'function') {
              set(this.$data.$meteor.subs, key, false)
              if (this._subsAutorun[key]) {
                this._subsAutorun[key].stop()
              }
              const autorun = this.$autorun(() => {
                const ready = handle.ready()
                set(this.$data.$meteor.subs, key, ready)
                // Wait for the new subscription to be ready before stoping the old one
                if (ready && oldSub) {
                  this.$stopHandle(oldSub)
                }
              })
              this._subsAutorun[key] = autorun
            }

            return handle
            // }
          } else {
            throw new Error('You must provide the publication name to $subscribe.')
          }
        },

        $subscribe (key, options) {
          let handle, unwatch
          let subscribe = params => {
            handle = this.$_subscribe(key, ...params)
          }

          if (typeof options === 'function') {
            if (isServer) {
              subscribe(options.bind(this)())
            } else {
              unwatch = this.$watch(options, params => {
                subscribe(params)
              }, {
                immediate: true,
              })
            }
          } else {
            subscribe(options)
          }

          return () => {
            if (unwatch) unwatch()
            if (handle) this.$stopHandle(handle)
          }
        },

        $autorun (reactiveFunction) {
          let handle = Tracker.autorun(reactiveFunction)
          this._trackerHandles.push(handle)
          return handle
        },

        $stopHandle (handle) {
          handle.stop()
          let index = this._trackerHandles.indexOf(handle)
          if (index !== -1) {
            this._trackerHandles.splice(index, 1)
          }
        },

        $startMeteor () {
          if (!this._meteorActive) {
            launch.call(this)
          }
        },

        $stopMeteor () {
          if (this._meteorActive) {
            // Stop all reactivity when view is destroyed.
            this._trackerHandles.forEach((tracker) => {
              try {
                tracker.stop()
              } catch (e) {
                console.error(e, tracker)
              }
            })
            this._trackerHandles = null
          }
          this._meteorActive = false
        },

        $addMeteorData (key, func) {
          if (this._meteorActive) {
            if (typeof func === 'function') {
              func = func.bind(this)
            } else {
              throw Error(`Meteor data '${key}': You must provide a function which returns the result.`)
            }

            if (hasProperty(this.$data, key) || hasProperty(this.$props, key) || hasProperty(this, key)) {
              throw Error(`Meteor data '${key}': Property already used in the component data, props or other.`)
            }
          }
          Object.defineProperty(this, key, {
            get: () => this.$data.$meteor.data[key],
            enumerable: true,
            configurable: true,
          })

          // Function run
          const setResult = result => {
            result = getResult(result)
            set(this.$data.$meteor.data, key, result)
          }

          // Vue autorun
          const unwatch = this.$watch(func, noop)
          const watcher = this._watchers.find(w => w.getter === func)

          // Meteor autorun
          let computation = this.$autorun(() => {
            // Vue watcher deps are also-rebuilt
            const result = watcher.get()
            setResult(result)
          })
          const unautorun = () => {
            if (computation) this.$stopHandle(computation)
          }
          // Update from Vue (override)
          watcher.update = () => {
            computation.invalidate()
          }

          return () => {
            unwatch()
            unautorun()
          }
        },

        $addComputed (key, watcher) {
          let computation, autorunMethod
          const autorun = (cb) => {
            if (!computation) {
              // Update from Meteor
              let dirty = false
              computation = autorunMethod(computation => {
                dirty = true
                watcher.value = getResult(cb.call(this))
                watcher.deps.forEach(dep => dep.notify())
                dirty = false
              })
              // Update from Vue (override)
              watcher.update = () => {
                if (!dirty) {
                  computation.invalidate()
                }
              }
            }
            return watcher.value
          }
          // Override getter to expose $autorun
          const func = watcher.getter
          watcher.getter = () => {
            autorunMethod = this.$autorun
            this.$autorun = autorun
            const result = func.call(this, this)
            this.$autorun = autorunMethod
            return result
          }
        },
      },
    })

    if (vueVersion === '2') {
      // Components
      Vue.component('MeteorData', CMeteorData)
      Vue.component('meteor-data', CMeteorData)
      Vue.component('MeteorSub', CMeteorSub)
      Vue.component('meteor-sub', CMeteorSub)
    }
  },
}

export const MeteorData = CMeteorData
export const MeteorSub = CMeteorSub
