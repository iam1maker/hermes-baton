// atvv-link — minimal CoreBluetooth bridge for ATVV remotes.
//
// The macOS Bluetooth stack only lets an application reach a peripheral that
// the system already holds through retrieveConnectedPeripherals(withServices:).
// noble cannot do that, so the BLE layer lives here while every protocol and
// audio decision stays in TypeScript.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   stdout events: state, device, connecting, connected, services, ready,
//                  control, audio, hid, disconnect, error, log, bye
//   stdin commands: {"cmd":"write","hex":"0c00"}
//                   {"cmd":"hid-watch"}
//                   {"cmd":"scan"}
//                   {"cmd":"quit"}

import Foundation
import CoreBluetooth
import IOKit.hid

// MARK: - Constants

let atvvService = CBUUID(string: "AB5E0001-5A21-4F05-BC7D-AF01F617B664")
let atvvTransmit = CBUUID(string: "AB5E0002-5A21-4F05-BC7D-AF01F617B664")
let atvvAudio = CBUUID(string: "AB5E0003-5A21-4F05-BC7D-AF01F617B664")
let atvvControl = CBUUID(string: "AB5E0004-5A21-4F05-BC7D-AF01F617B664")
let hidService = CBUUID(string: "00001812-0000-1000-8000-00805F9B34FB")
let batteryService = CBUUID(string: "0000180F-0000-1000-8000-00805F9B34FB")
let batteryLevel = CBUUID(string: "00002A19-0000-1000-8000-00805F9B34FB")
let hidReport = CBUUID(string: "00002A4D-0000-1000-8000-00805F9B34FB")

// MARK: - Line IO

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8) else { return }
    stdoutLock.lock()
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
    stdoutLock.unlock()
}

func emitLog(_ message: String) {
    emit(["event": "log", "message": message])
}

func emitBinary(_ event: String, _ data: Data, extra: [String: Any] = [:]) {
    var payload = extra
    payload["event"] = event
    payload["b64"] = data.base64EncodedString()
    emit(payload)
}

func stateName(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    default: return "unknown"
    }
}

// MARK: - Options

/// 用法只有一行：参数错误时打到 stderr 并 exit 2，不静默忽略。
/// 桥的 stdout 是 JSON 事件流，错参数不能混进去，否则调用方只看到「桥没反应」。
let usageLine = "usage: atvv-link [--device <uuid>] [--name <text>] [--hid] [--list [seconds]] [--hid-device <vid:pid>]... [--hid-pages <hex,hex,...>]"

func failUsage(_ message: String) -> Never {
    let text = "atvv-link: \(message)\n\(usageLine)\n"
    FileHandle.standardError.write(text.data(using: .utf8)!)
    exit(2)
}

/// VID/PID 这类编号：先按十六进制认，失败再按十进制认，两种写法都吃。
/// 十六进制可带 0x/0X 前缀——Swift 的 UInt32(_:radix:) 自己不剥前缀，得先去掉。
func parseFlexibleNumber(_ raw: String) -> UInt32? {
    let text = raw.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return nil }
    if text.lowercased().hasPrefix("0x") {
        let body = String(text.dropFirst(2))
        guard !body.isEmpty else { return nil }
        return UInt32(body, radix: 16)
    }
    if let hex = UInt32(text, radix: 16) { return hex }
    return UInt32(text, radix: 10)
}

/// usage page 只按十六进制解析（7 / 0x0c / ff00 这种）。页号本来就是十六进制惯例，
/// 再猜十进制会让 `10` 这种写法含义漂移，宁可报错。
func parseUsagePage(_ raw: String) -> UInt32? {
    var text = raw.trimmingCharacters(in: .whitespaces)
    if text.lowercased().hasPrefix("0x") { text = String(text.dropFirst(2)) }
    guard !text.isEmpty else { return nil }
    return UInt32(text, radix: 16)
}

struct Options {
    var deviceID: UUID?
    /// 空字符串 = 不按名字过滤。调用方已经用 ATVV 服务 UUID 圈定过设备时，
    /// 任何暴露 AB5E0001 的遥控器都是语音遥控器，不必按型号硬编码。
    var nameNeedle: String = ""
    var watchHID = false
    /// > 0 时进入列表模式：列出候选遥控器后退出，不建立长连接。
    var listSeconds: Double = 0
    /// 额外要监听键位的 HID 设备（VID, PID），用于新遥控器型号。
    var hidDevices: [(UInt32, UInt32)] = []
    /// 放行的 HID usage page 集合。默认与原硬编码行为一致：0x07 键盘集合、
    /// 0x0C Consumer Control、0xFF00 厂商位域。型号注册表会把各型号声明的
    /// pages 并集通过 --hid-pages 传进来，于是新增遥控器型号不必重编桥。
    var hidPages: Set<UInt32> = [0x07, 0x0c, 0xff00]
}

func parseOptions() -> Options {
    var options = Options()
    var args = Array(CommandLine.arguments.dropFirst())

    /// 取一个选项值；缺失就报错，别把下一个选项当值吃掉。
    func takeValue(_ name: String) -> String {
        guard !args.isEmpty else { failUsage("\(name) needs a value") }
        let value = args.removeFirst()
        guard !value.hasPrefix("--") else { failUsage("\(name) needs a value, got \(value)") }
        return value
    }

    while !args.isEmpty {
        let arg = args.removeFirst()
        switch arg {
        case "--help", "-h":
            print(usageLine)
            exit(0)
        case "--device":
            let raw = takeValue("--device")
            guard let uuid = UUID(uuidString: raw) else { failUsage("bad device uuid: \(raw)") }
            options.deviceID = uuid
        case "--name":
            options.nameNeedle = takeValue("--name")
        case "--hid":
            options.watchHID = true
        case "--list":
            options.listSeconds = 8
            if let first = args.first, !first.hasPrefix("--") {
                guard let seconds = Double(first) else { failUsage("bad --list seconds: \(first)") }
                options.listSeconds = seconds
                args.removeFirst()
            }
        case "--hid-device":
            let spec = takeValue("--hid-device")
            let parts = spec.split(separator: ":")
            guard parts.count == 2,
                  let vid = parseFlexibleNumber(String(parts[0])),
                  let pid = parseFlexibleNumber(String(parts[1])) else {
                failUsage("bad --hid-device spec: \(spec) (want vid:pid)")
            }
            options.hidDevices.append((vid, pid))
        case "--hid-pages":
            let spec = takeValue("--hid-pages")
            var pages = Set<UInt32>()
            for token in spec.split(separator: ",") {
                guard let page = parseUsagePage(String(token)) else {
                    failUsage("bad --hid-pages entry: \(token) (want hex)")
                }
                pages.insert(page)
            }
            guard !pages.isEmpty else { failUsage("--hid-pages needs at least one page") }
            options.hidPages = pages
        default:
            failUsage("unknown argument: \(arg)")
        }
    }
    return options
}

// MARK: - Link

final class Link: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let options: Options
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var transmit: CBCharacteristic?
    private var audio: CBCharacteristic?
    private var control: CBCharacteristic?
    private var audioSubscribed = false
    private var controlSubscribed = false
    private var capsRequested = false
    private var hidRequested = false
    private var batteryRequested = false
    private var atvvDiscovered = false
    private var reconnectAttempt = 0
    private var shuttingDown = false

    init(options: Options) {
        self.options = options
        super.init()
        central = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: true])
    }

    // MARK: discovery

    private func matches(_ name: String?) -> Bool {
        let needle = options.nameNeedle
        // 空 needle = 接受任何 ATVV 设备：discover() 的接入点已经用服务 UUID
        // 圈过范围，再按型号挑名字只会把新遥控器挡在外面。
        guard !needle.isEmpty else { return true }
        guard let name else { return false }
        if name.localizedCaseInsensitiveContains(needle) { return true }
        // 历史名字兜底：小米遥控器在不同固件里叫过这两种。
        let lower = name.lowercased()
        return lower == "mi rc" || lower.hasPrefix("xiaomi bluetooth remote 2")
    }

    private func matches(_ peripheral: CBPeripheral) -> Bool {
        matches(peripheral.name)
    }

    /// 扫描兜底时是否应当立刻连上去。
    /// 空 needle 时只认广播里真带 ATVV 服务的设备——否则会连上旁边任意一台 BLE
    /// 外设；指定了名字时按名字放行，因为不少 ATVV 遥控器不广播服务 UUID。
    private func shouldConnectOnSight(advertisedName: String,
                                      peripheral: CBPeripheral,
                                      advertisementData: [String: Any]) -> Bool {
        if options.nameNeedle.isEmpty {
            let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
            return services.contains(atvvService)
        }
        return matches(advertisedName) || matches(peripheral)
    }

    func discover() {
        guard central.state == .poweredOn else { return }

        if options.listSeconds > 0 {
            startListing()
            return
        }

        let connected = central.retrieveConnectedPeripherals(withServices: [atvvService])
        // 指定了设备（UUID 或名字）时，**绝不**回退到「候选里的第一台」：那会把一次
        // 切换静默变成「连回上一台」。实测症状：settings 已改成小米、桥也重启了，
        // /state 却依旧是 Chromecast——因为 187 行的缓存查询永远轮不到。
        // UUID 优先于名字：已连接的 CBPeripheral.name 可能是 nil（固件不回名字），
        // 而名字匹配对 nil 一律 false。
        let byID = options.deviceID.flatMap { wanted in
            connected.first { $0.identifier == wanted }
        }
        let explicit = byID != nil || !options.nameNeedle.isEmpty
        let match = byID ?? connected.first(where: matches) ?? (explicit ? nil : connected.first)
        if let match {
            emitLog("found system-connected peripheral: \(match.name ?? "?")")
            connect(match)
            return
        }

        if let deviceID = options.deviceID {
            let cached = central.retrievePeripherals(withIdentifiers: [deviceID])
            if let match = cached.first {
                emitLog("found cached peripheral: \(match.name ?? "?")")
                connect(match)
                return
            }
        }

        emitLog("scanning")
        central.scanForPeripherals(withServices: nil, options: nil)
    }

    // MARK: listing

    private var listed: Set<UUID> = []

    private func reportCandidate(_ peripheral: CBPeripheral, name: String?, connected: Bool) {
        guard listed.insert(peripheral.identifier).inserted else { return }
        emit(["event": "candidate",
              "id": peripheral.identifier.uuidString,
              "name": name ?? peripheral.name ?? "",
              "connected": connected])
    }

    private func startListing() {
        let connected = central.retrieveConnectedPeripherals(withServices: [atvvService])
        for peripheral in connected {
            reportCandidate(peripheral, name: peripheral.name, connected: true)
        }
        emitLog("scanning for \(options.listSeconds)s")
        central.scanForPeripherals(withServices: nil, options: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + options.listSeconds) { [weak self] in
            self?.central.stopScan()
            emit(["event": "bye", "reason": "list complete"])
            exit(0)
        }
    }

    private func connect(_ peripheral: CBPeripheral) {
        self.peripheral = peripheral
        peripheral.delegate = self
        emit(["event": "connecting", "name": peripheral.name ?? "", "id": peripheral.identifier.uuidString])
        central.connect(peripheral, options: nil)
    }

    private func scheduleReconnect() {
        guard !shuttingDown else { return }
        reconnectAttempt = min(reconnectAttempt + 1, 5)
        let delay = min(2.0 * Double(reconnectAttempt), 10.0)
        emitLog("reconnect in \(delay)s")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.discover()
        }
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        emit(["event": "state", "value": stateName(central.state)])
        if central.state == .poweredOn {
            discover()
        } else if central.state == .unauthorized {
            emit(["event": "error", "message": "Bluetooth permission denied for this process"])
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        let advertisedName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
        if options.listSeconds > 0 {
            let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
            let looksLikeRemote = advertisedName.localizedCaseInsensitiveContains("remote")
                || advertisedName.contains("遥控")
                || services.contains(atvvService)
            if looksLikeRemote { reportCandidate(peripheral, name: advertisedName, connected: false) }
            return
        }
        emit(["event": "device", "id": peripheral.identifier.uuidString,
              "name": advertisedName, "rssi": RSSI.intValue])
        guard shouldConnectOnSight(advertisedName: advertisedName,
                                   peripheral: peripheral,
                                   advertisementData: advertisementData) else { return }
        central.stopScan()
        connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        reconnectAttempt = 0
        emit(["event": "connected", "name": peripheral.name ?? "",
              "id": peripheral.identifier.uuidString])
        peripheral.discoverServices([atvvService, batteryService, hidService])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        emit(["event": "error", "message": "connect failed: \(error?.localizedDescription ?? "unknown")"])
        scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        transmit = nil
        audio = nil
        control = nil
        audioSubscribed = false
        controlSubscribed = false
        capsRequested = false
        hidRequested = false
        atvvDiscovered = false
        emit(["event": "disconnect", "reason": error?.localizedDescription ?? "link lost"])
        scheduleReconnect()
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            emit(["event": "error", "message": "service discovery failed: \(error.localizedDescription)"])
            return
        }
        let uuids = (peripheral.services ?? []).map { $0.uuid.uuidString }
        emit(["event": "services", "uuids": uuids])
        for service in peripheral.services ?? [] {
            if service.uuid == atvvService, !atvvDiscovered {
                atvvDiscovered = true
                peripheral.discoverCharacteristics([atvvTransmit, atvvAudio, atvvControl], for: service)
            } else if service.uuid == hidService {
                peripheral.discoverCharacteristics([hidReport], for: service)
            } else if service.uuid == batteryService, !batteryRequested {
                batteryRequested = true
                peripheral.discoverCharacteristics([batteryLevel], for: service)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        if let error {
            emit(["event": "error", "message": "characteristic discovery failed: \(error.localizedDescription)"])
            return
        }
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case atvvTransmit: transmit = characteristic
            case atvvAudio: audio = characteristic
            case atvvControl: control = characteristic
            case batteryLevel:
                peripheral.readValue(for: characteristic)
            default: break
            }
        }
        guard let audio, let control else {
            emit(["event": "error", "message": "ATVV characteristics incomplete"])
            return
        }
        peripheral.setNotifyValue(true, for: audio)
        peripheral.setNotifyValue(true, for: control)
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error {
            emit(["event": "error", "message": "subscribe \(characteristic.uuid.uuidString.prefix(8)) failed: \(error.localizedDescription)"])
            return
        }
        if characteristic.uuid == atvvAudio { audioSubscribed = true }
        if characteristic.uuid == atvvControl { controlSubscribed = true }

        guard audioSubscribed, controlSubscribed, !capsRequested, let transmit else { return }
        capsRequested = true
        peripheral.writeValue(Data([0x0A, 0x01, 0x00, 0x00, 0x03, 0x03]), for: transmit,
                              type: transmit.properties.contains(.write) ? .withResponse : .withoutResponse)
        emit(["event": "ready", "name": peripheral.name ?? "",
              "id": peripheral.identifier.uuidString])
        if options.watchHID { watchHID() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard let data = characteristic.value else { return }
        if characteristic.uuid == atvvAudio {
            emitBinary("audio", data)
        } else if characteristic.uuid == atvvControl {
            emitBinary("control", data)
        } else if characteristic.uuid == batteryLevel {
            if let percent = data.first {
                emit(["event": "battery", "percent": Int(percent)])
            }
        } else {
            emitBinary("hid", data, extra: ["uuid": characteristic.uuid.uuidString])
        }
    }

    // MARK: HID over GATT

    private func watchHID() {
        guard let peripheral, !hidRequested else { return }
        hidRequested = true
        let services = peripheral.services ?? []
        if let hid = services.first(where: { $0.uuid == hidService }) {
            peripheral.discoverCharacteristics([hidReport], for: hid)
            return
        }
        emitLog("requesting HID-over-GATT service discovery")
        peripheral.discoverServices([hidService])
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverIncludedServicesFor service: CBService,
                    error: Error?) {}

    // MARK: stdin commands

    func handle(_ command: [String: Any]) {
        guard let cmd = command["cmd"] as? String else { return }
        switch cmd {
        case "write":
            guard let hex = command["hex"] as? String, let data = Data(hexString: hex), let transmit else { return }
            peripheral?.writeValue(data, for: transmit,
                                   type: transmit.properties.contains(.write) ? .withResponse : .withoutResponse)
        case "hid-watch":
            watchHID()
        case "scan":
            discover()
        case "quit":
            shuttingDown = true
            if let peripheral { central.cancelPeripheralConnection(peripheral) }
            emit(["event": "bye"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
        default:
            emit(["event": "error", "message": "unknown command \(cmd)"])
        }
    }
}

// MARK: - Helpers

extension Data {
    init?(hexString: String) {
        let cleaned = hexString.filter { $0.isHexDigit }
        guard cleaned.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(cleaned.count / 2)
        var index = cleaned.startIndex
        while index < cleaned.endIndex {
            let next = cleaned.index(index, offsetBy: 2)
            guard let byte = UInt8(cleaned[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self = Data(bytes)
    }
}

// MARK: - Global HID keys

/// Reads the remote's non-ATVV keys (Back, volume) without seizing the device.
///
/// macOS keeps the remote attached as a normal keyboard, and an exclusive
/// `kIOHIDOptionsTypeSeizeDevice` open would break the system shortcuts, so
/// this opens the manager non-exclusively and only reports key-down values.
/// Requires Input Monitoring permission; without it the bridge keeps working
/// and logs one hint instead of failing.
final class HIDKeyReader {
    private var manager: IOHIDManager?
    private var started = false
    private let extraDevices: [(UInt32, UInt32)]
    private let pages: Set<UInt32>

    init(extraDevices: [(UInt32, UInt32)] = [], pages: Set<UInt32> = [0x07, 0x0c, 0xff00]) {
        self.extraDevices = extraDevices
        self.pages = pages
    }

    func start() {
        guard !started else { return }
        started = true
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        // 每台已知遥控器一条精确的 VID/PID 匹配：遥控器的按键集合和普通键盘重叠，
        // 只有把范围钉死在遥控器上才不会吞掉内置键盘或蓝牙键盘的按键。
        // 新遥控器型号只需在这里加一行，或用 --hid-device vid:pid 传入。
        var matchers: [[String: Any]] = [
            [kIOHIDVendorIDKey: 0x2717, kIOHIDProductIDKey: 0x32b8],  // 小米蓝牙语音遥控器 2 / 2 Pro
            [kIOHIDVendorIDKey: 0x18d1, kIOHIDProductIDKey: 0x9450],  // Chromecast with Google TV Remote
        ]
        for (vid, pid) in extraDevices {
            matchers.append([kIOHIDVendorIDKey: Int(vid), kIOHIDProductIDKey: Int(pid)])
        }
        IOHIDManagerSetDeviceMatchingMultiple(mgr, matchers as CFArray)
        IOHIDManagerRegisterInputValueCallback(mgr, { context, result, _, value in
            guard result == kIOReturnSuccess, let context else { return }
            let reader = Unmanaged<HIDKeyReader>.fromOpaque(context).takeUnretainedValue()
            reader.handle(value)
        }, Unmanaged.passUnretained(self).toOpaque())
        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        let status = IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone))
        if status == kIOReturnSuccess {
            emitLog("HID key reader active")
        } else if status == kIOReturnNotPermitted {
            emitLog("HID key reader needs Input Monitoring (System Settings → Privacy & Security → Input Monitoring → atvv-link)")
        } else {
            emitLog("HID key reader unavailable (IOReturn 0x\(String(status, radix: 16)))")
        }
        manager = mgr
    }

    private func handle(_ value: IOHIDValue) {
        let element = IOHIDValueGetElement(value)
        let page = IOHIDElementGetUsagePage(element)
        let usage = IOHIDElementGetUsage(element)
        // 放行哪些页由 --hid-pages 决定，默认仍是这三页：
        // 0x07 键盘集合（小米把 Back/音量塞在这里）、0x0C Consumer Control
        // （Chromecast 遥控器的主集合就是 Consumer，漏掉这一页等于一个键都收不到）、
        // 0xFF00 厂商位域（usage 恒为 0xFFFFFFFF，解码在 TypeScript 侧）。
        // 新型号只要在自己的 JSON 里声明 pages，注册表把并集传进来，不必重编桥。
        guard pages.contains(page) else { return }
        let intValue = IOHIDValueGetIntegerValue(value)
        var payload: [String: Any] = [
            "event": "hidkey",
            "page": Int(page),
            "usage": Int(usage),
            "value": Int(intValue),
        ]
        let device = IOHIDElementGetDevice(element)
        if let product = IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String {
            payload["device"] = product
        }
        if let vid = IOHIDDeviceGetProperty(device, kIOHIDVendorIDKey as CFString) as? Int {
            payload["vid"] = vid
        }
        if let pid = IOHIDDeviceGetProperty(device, kIOHIDProductIDKey as CFString) as? Int {
            payload["pid"] = pid
        }
        emit(payload)
    }
}

// MARK: - Main

let options = parseOptions()
let link = Link(options: options)
let hidKeys = HIDKeyReader(extraDevices: options.hidDevices, pages: options.hidPages)
hidKeys.start()

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty,
              let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { link.handle(object) }
    }
    DispatchQueue.main.async { emit(["event": "bye", "reason": "stdin closed"]); exit(0) }
}
reader.start()

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

emit(["event": "log", "message": "atvv-link started"])
RunLoop.main.run()
