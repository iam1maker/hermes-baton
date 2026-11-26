// 按键归属单元测试：默认只有当前生效的那台管事（'active'），'any' 才是两台都认。
//
// 背景：桥用 IOHIDManager 旁听整机，两台遥控器同时连着系统时两边的按键都会进来。
// 用户要求「除了音量键，其他按键始终应该是生效的那台按了才有用」——语音键本来就只走
// 连上的那台，按键跟着它，另一台（可能被压在包里）就不会误触。音量键归 macOS 系统层，
// 不经过插件。
// 这里不碰硬件，直接给 service 喂 transport 事件，断言 emit('key') 的有无。
import { TypedEmitter } from '../sidecar/vendor/util/emitter.js'
import { RemoteMicService } from '../sidecar/vendor/plugin/service.js'

let fails = 0
const check = (label, ok, extra) => {
  if (!ok) fails += 1
  console.log(label, ok ? 'PASS' : 'FAIL', extra === undefined ? '' : JSON.stringify(extra))
}

const make = ({ targetDeviceName, keyFilter } = {}) => {
  const transport = new TypedEmitter()
  transport.write = () => {}
  const keys = []
  const logs = []
  const service = new RemoteMicService({
    transport,
    transcribe: async () => ({ text: '', audioSeconds: 0, inferenceSeconds: 0 }),
    log: line => logs.push(String(line)),
    targetDeviceName,
    keyFilter
  })
  service.on('key', event => keys.push(event))
  return { transport, keys, logs, service }
}

const BACK = { page: 0x07, usage: 0x00f1, value: 1 } // page 0x07 usage 0xF1 → Back
const hidkey = (transport, device, base = BACK) => transport.emit('hidkey', { ...base, device })

// 1) 默认（不传 keyFilter）→ 只认当前设备，这是开箱行为
{
  const { transport, keys } = make({ targetDeviceName: () => '小米蓝牙语音遥控器' })
  hidkey(transport, 'Chromecast Remote')
  check('默认：非当前设备被忽略', keys.length === 0, keys)
  hidkey(transport, '小米蓝牙语音遥控器')
  check('默认：当前设备通过', keys.length === 1, keys)
}

// 2) 显式 'any' → 同上
{
  const { transport, keys } = make({ targetDeviceName: () => 'Chromecast Remote', keyFilter: () => 'any' })
  hidkey(transport, '小米蓝牙语音遥控器')
  check('keyFilter=any 不过滤', keys.length === 1, keys)
}

// 3) 'active' + 配置目标名 → 另一台的键被忽略，且只记一条日志
{
  const { transport, keys, logs } = make({
    targetDeviceName: () => '小米蓝牙语音遥控器',
    keyFilter: () => 'active'
  })
  hidkey(transport, 'Chromecast Remote')
  check('active：非当前设备按键被忽略', keys.length === 0, keys)
  check('active：忽略只记一条日志', logs.filter(l => l.includes('忽略非当前设备')).length === 1, logs)
  hidkey(transport, 'Chromecast Remote')
  check('active：重复按不刷日志', logs.filter(l => l.includes('忽略非当前设备')).length === 1, logs)
  hidkey(transport, '小米蓝牙语音遥控器')
  check('active：当前设备按键通过', keys.length === 1 && keys[0].code === 'Back', keys)
}

// 4) 'active' 下桥上报了 device（切换后）→ 以桥为准，压过配置里的旧目标名
{
  const { transport, keys } = make({
    targetDeviceName: () => '小米蓝牙语音遥控器',
    keyFilter: () => 'active'
  })
  transport.emit('device', { id: 'uuid-cast', name: 'Chromecast Remote' })
  hidkey(transport, '小米蓝牙语音遥控器')
  check('active：切换后旧设备按键被忽略', keys.length === 0, keys)
  hidkey(transport, 'Chromecast Remote')
  check('active：切换后新设备按键通过', keys.length === 1, keys)
}

// 5) 'active' 但谁都没报设备名（CBPeripheral.name 可为 nil）→ 不能把键全丢了
{
  const { transport, keys } = make({ targetDeviceName: () => '', keyFilter: () => 'active' })
  hidkey(transport, 'Chromecast Remote')
  hidkey(transport, '小米蓝牙语音遥控器')
  check('active：无目标时 fail-open', keys.length === 2, keys)
}

// 6) 'active' 但桥没带 device 字段（老桥/其他传输）→ 同样不过滤
{
  const { transport, keys } = make({ targetDeviceName: () => '小米蓝牙语音遥控器', keyFilter: () => 'active' })
  transport.emit('hidkey', { ...BACK })
  check('active：缺 device 字段时不误杀', keys.length === 1, keys)
}

// 7) 运行中改开关立即生效（配置是函数读的，改完不用重启服务）
{
  let mode = 'active'
  const { transport, keys } = make({ targetDeviceName: () => 'Chromecast Remote', keyFilter: () => mode })
  hidkey(transport, '小米蓝牙语音遥控器')
  const blocked = keys.length === 0
  mode = 'any'
  hidkey(transport, '小米蓝牙语音遥控器')
  check('热改 keyFilter 立即生效', blocked && keys.length === 1, keys)
}

console.log(fails === 0 ? 'HID FILTER SUMMARY pass' : `HID FILTER SUMMARY ${fails} fail`)
process.exit(fails === 0 ? 0 : 1)
