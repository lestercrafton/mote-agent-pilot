// Compile-only native preparation. --self-test NEVER invokes a Security/Keychain API.
// Real operations require a separate explicit activation, private pipes and exact metadata.
import Foundation
import Security
import Darwin

struct CustodyFailure: Error { let code: String }
func require(_ condition: Bool, _ code: String = "INVALID_REQUEST") throws {
    if !condition { throw CustodyFailure(code: code) }
}
let services = ["quote-backup": "org.mote.ethereum-sepolia.quote.v1", "bootstrap": "org.mote.ethereum-sepolia.bootstrap.v1"]
struct Request {
    let operation: String, role: String, service: String, account: String
    var metadata: Data { Data("mote-keychain-v1|11155111|\(role)|helper-only-no-ui".utf8) }
    init(_ object: [String: Any]) throws {
        let names: Set<String> = ["protocol", "operation", "role", "chainId", "service", "account", "access"]
        try require(Set(object.keys) == names)
        try require(object["protocol"] as? String == "mote-keychain-v1")
        guard let op = object["operation"] as? String, ["create", "read"].contains(op),
              let selectedRole = object["role"] as? String, let selectedService = services[selectedRole] else {
            throw CustodyFailure(code: "WRONG_ROLE_OR_OPERATION")
        }
        try require(object["chainId"] as? Int == 11155111, "WRONG_CHAIN")
        let selectedAccount = "ethereum-sepolia:\(selectedRole):v1"
        try require(object["service"] as? String == selectedService && object["account"] as? String == selectedAccount, "WRONG_LABEL")
        try require(object["access"] as? String == "helper-only-no-ui", "OVERBROAD_ACCESS")
        operation = op; role = selectedRole; service = selectedService; account = selectedAccount
    }
}
func status(_ value: OSStatus, _ code: String) throws { try require(value == errSecSuccess, code) }
func privatePipe(_ descriptor: Int32) throws {
    var info = stat()
    try require(fstat(descriptor, &info) == 0 && isatty(descriptor) == 0, "PRIVATE_PIPE_REQUIRED")
    let kind = info.st_mode & mode_t(S_IFMT)
    try require(kind == mode_t(S_IFIFO) || kind == mode_t(S_IFSOCK), "PRIVATE_PIPE_REQUIRED")
}
func privateChannels() throws {
    try privatePipe(3); try privatePipe(4)
    for secretDescriptor: Int32 in [3, 4] {
        var secretInfo = stat()
        try require(fstat(secretDescriptor, &secretInfo) == 0, "PRIVATE_PIPE_REQUIRED")
        for publicDescriptor: Int32 in [0, 1, 2] {
            var publicInfo = stat()
            if fstat(publicDescriptor, &publicInfo) == 0 {
                try require(secretInfo.st_dev != publicInfo.st_dev || secretInfo.st_ino != publicInfo.st_ino, "PRIVATE_PIPE_ALIASED_TO_STDIO")
            }
        }
    }
    var first = stat(), second = stat()
    try require(fstat(3, &first) == 0 && fstat(4, &second) == 0 && (first.st_dev != second.st_dev || first.st_ino != second.st_ino), "PRIVATE_PIPES_MUST_DIFFER")
}
func readBounded(_ descriptor: Int32, maximum: Int) throws -> Data {
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    var result = Data()
    while true {
        guard let chunk = try handle.read(upToCount: maximum + 1 - result.count), !chunk.isEmpty else { break }
        result.append(chunk)
        try require(result.count <= maximum, "INPUT_TOO_LARGE")
    }
    return result
}
func trustedSelf() throws -> SecTrustedApplication {
    var application: SecTrustedApplication?
    try status(SecTrustedApplicationCreateFromPath(nil, &application), "TRUSTED_HELPER_UNAVAILABLE")
    guard let result = application else { throw CustodyFailure(code: "TRUSTED_HELPER_UNAVAILABLE") }
    return result
}
func appData(_ application: SecTrustedApplication) throws -> Data {
    var data: CFData?
    try status(SecTrustedApplicationCopyData(application, &data), "ACCESS_UNVERIFIABLE")
    guard let result = data else { throw CustodyFailure(code: "ACCESS_UNVERIFIABLE") }
    return result as Data
}
// No wildcard application ACL is accepted. Even administrative ACL entries must name
// this exact helper, zero prompt flags and the fixed label. Authorization-tag
// and owner/partition semantics are not a full ACL audit; native behavior is unverified.
func verifyAccess(_ access: SecAccess, trusted: SecTrustedApplication, label: String) throws {
    var list: CFArray?
    try status(SecAccessCopyACLList(access, &list), "ACCESS_UNVERIFIABLE")
    guard let entries = list as? [SecACL], !entries.isEmpty else { throw CustodyFailure(code: "ACCESS_UNVERIFIABLE") }
    let expected = try appData(trusted)
    for acl in entries {
        var applications: CFArray?, description: CFString?
        var prompt = SecKeychainPromptSelector(rawValue: 0)
        try status(SecACLCopyContents(acl, &applications, &description, &prompt), "ACCESS_UNVERIFIABLE")
        try require(prompt.rawValue == 0 && description as String? == label, "ACCESS_UNVERIFIABLE")
        guard let apps = applications as? [SecTrustedApplication], apps.count == 1 else { throw CustodyFailure(code: "OVERBROAD_ACCESS") }
        try require(try appData(apps[0]) == expected, "OVERBROAD_ACCESS")
    }
}
func restrictedAccess(_ request: Request, trusted: SecTrustedApplication) throws -> SecAccess {
    var access: SecAccess?
    try status(SecAccessCreate(request.service as CFString, [trusted] as CFArray, &access), "ACCESS_CREATION_FAILED")
    guard let result = access else { throw CustodyFailure(code: "ACCESS_CREATION_FAILED") }
    var list: CFArray?
    try status(SecAccessCopyACLList(result, &list), "ACCESS_CREATION_FAILED")
    guard let entries = list as? [SecACL], !entries.isEmpty else { throw CustodyFailure(code: "ACCESS_CREATION_FAILED") }
    for acl in entries {
        try status(SecACLSetContents(acl, [trusted] as CFArray, request.service as CFString, SecKeychainPromptSelector(rawValue: 0)), "ACCESS_CREATION_FAILED")
    }
    try verifyAccess(result, trusted: trusted, label: request.service)
    return result
}
func existingLoginKeychain() throws -> SecKeychain {
    let location = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Keychains/login.keychain-db")
    try require(location.resolvingSymlinksInPath().path == location.path, "LOGIN_KEYCHAIN_SYMLINK_FORBIDDEN")
    var info = stat()
    try require(lstat(location.path, &info) == 0 && (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) && info.st_uid == getuid() && (info.st_mode & 0o077) == 0, "LOGIN_KEYCHAIN_UNAVAILABLE")
    var keychain: SecKeychain?
    try status(SecKeychainOpen(location.path, &keychain), "LOGIN_KEYCHAIN_UNAVAILABLE")
    guard let selected = keychain else { throw CustodyFailure(code: "LOGIN_KEYCHAIN_UNAVAILABLE") }
    var state: SecKeychainStatus = 0
    try status(SecKeychainGetStatus(selected, &state), "LOGIN_KEYCHAIN_UNAVAILABLE")
    try require((state & kSecUnlockStateStatus) != 0, "LOGIN_KEYCHAIN_LOCKED")
    return selected
}
func query(_ request: Request, keychain: SecKeychain) -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword,
            kSecMatchSearchList as String: [keychain],
            kSecAttrService as String: request.service,
            kSecAttrAccount as String: request.account,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
}
func assertLabelAbsent(_ request: Request, keychain: SecKeychain) throws {
    for attribute in [kSecAttrService, kSecAttrLabel] {
        let lookup: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                  kSecMatchSearchList as String: [keychain],
                                  attribute as String: request.service,
                                  kSecMatchLimit as String: kSecMatchLimitOne,
                                  kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        let result = SecItemCopyMatching(lookup as CFDictionary, nil)
        try require(result == errSecItemNotFound, result == errSecSuccess ? "ALREADY_EXISTS" : "EXISTENCE_UNVERIFIABLE")
    }
}
func inspectItem(_ request: Request, trusted: SecTrustedApplication, keychain: SecKeychain) throws -> SecKeychainItem {
    var lookup = query(request, keychain: keychain)
    lookup[kSecReturnAttributes as String] = true
    lookup[kSecReturnRef as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var output: CFTypeRef?
    try status(SecItemCopyMatching(lookup as CFDictionary, &output), "ITEM_UNAVAILABLE")
    guard let fields = output as? [String: Any], let reference = fields[kSecValueRef as String] else { throw CustodyFailure(code: "ITEM_UNVERIFIABLE") }
    try require(fields[kSecAttrService as String] as? String == request.service && fields[kSecAttrAccount as String] as? String == request.account)
    try require(fields[kSecAttrLabel as String] as? String == request.service && fields[kSecAttrGeneric as String] as? Data == request.metadata, "ITEM_IDENTITY_MISMATCH")
    try require((fields[kSecAttrSynchronizable as String] as? Bool ?? false) == false, "OVERBROAD_ACCESS")
    try require(CFGetTypeID(reference as CFTypeRef) == SecKeychainItemGetTypeID(), "ITEM_UNVERIFIABLE")
    let item = unsafeBitCast(reference as AnyObject, to: SecKeychainItem.self)
    var access: SecAccess?
    try status(SecKeychainItemCopyAccess(item, &access), "ACCESS_UNVERIFIABLE")
    guard let foundAccess = access else { throw CustodyFailure(code: "ACCESS_UNVERIFIABLE") }
    try verifyAccess(foundAccess, trusted: trusted, label: request.service)
    return item
}
func realOperation(_ request: Request) throws {
    // Private pipes are checked before ANY Security framework call. No UI fallback.
    try privateChannels()
    try status(SecKeychainSetUserInteractionAllowed(false), "NO_UI_UNAVAILABLE")
    let keychain = try existingLoginKeychain()
    let trusted = try trustedSelf()
    if request.operation == "create" {
        var key = try readBounded(3, maximum: 32)
        defer { key.resetBytes(in: 0..<key.count) }
        let order: [UInt8] = [0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xfe,0xba,0xae,0xdc,0xe6,0xaf,0x48,0xa0,0x3b,0xbf,0xd2,0x5e,0x8c,0xd0,0x36,0x41,0x41]
        try require(key.count == 32 && key.contains(where: { $0 != 0 }) && Array(key).lexicographicallyPrecedes(order), "INVALID_KEY_MATERIAL")
        // The deliberately public fixture scalar is prohibited in real storage.
        try require(key != Data(repeating: 0, count: 31) + Data([1]), "PUBLIC_FIXTURE_FORBIDDEN")
        try assertLabelAbsent(request, keychain: keychain)
        var attributes = query(request, keychain: keychain)
        attributes.removeValue(forKey: kSecMatchSearchList as String)
        attributes[kSecUseKeychain as String] = keychain
        attributes[kSecAttrLabel as String] = request.service
        attributes[kSecAttrGeneric as String] = request.metadata
        attributes[kSecAttrAccess as String] = try restrictedAccess(request, trusted: trusted)
        attributes[kSecValueData as String] = key
        try status(SecItemAdd(attributes as CFDictionary, nil), "CREATE_FAILED_OR_ALREADY_EXISTS")
        // If inspection fails after creation, report failure and retain the item for
        // explicit reconciliation. Never overwrite/delete/retry as compensation.
        _ = try inspectItem(request, trusted: trusted, keychain: keychain)
    } else {
        let extra = try readBounded(3, maximum: 0)
        try require(extra.isEmpty, "UNEXPECTED_SECRET_INPUT")
        let item = try inspectItem(request, trusted: trusted, keychain: keychain)
        var length: UInt32 = 0, pointer: UnsafeMutableRawPointer?
        try status(SecKeychainItemCopyContent(item, nil, nil, &length, &pointer), "READ_FAILED")
        defer { if let raw = pointer { _ = memset_s(raw, Int(length), 0, Int(length)); SecKeychainItemFreeContent(nil, raw) } }
        guard length == 32, let raw = pointer else { throw CustodyFailure(code: "INVALID_KEY_MATERIAL") }
        var key = Data(bytes: raw, count: Int(length))
        defer { key.resetBytes(in: 0..<key.count) }
        try FileHandle(fileDescriptor: 4, closeOnDealloc: false).write(contentsOf: key)
    }
}
func selfTest() throws {
    let base: [String: Any] = ["protocol": "mote-keychain-v1", "operation": "create", "role": "quote-backup", "chainId": 11155111, "service": services["quote-backup"]!, "account": "ethereum-sepolia:quote-backup:v1", "access": "helper-only-no-ui"]
    let request = try Request(base)
    var store = [String: Data]() // Fake memory only. No Security calls in this branch.
    store[request.service] = Data(repeating: 0, count: 31) + Data([1])
    try require(store[request.service]?.count == 32)
    for (field, value) in [("chainId", 1 as Any), ("role", "deployer" as Any), ("access", "all-applications" as Any), ("service", "unrelated" as Any), ("operation", "delete" as Any)] {
        var invalid = base; invalid[field] = value
        do { _ = try Request(invalid); throw CustodyFailure(code: "SELF_TEST_FAILED") }
        catch let error as CustodyFailure { if error.code == "SELF_TEST_FAILED" { throw error } }
    }
    store.removeAll()
}
do {
    if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
        try selfTest()
        FileHandle.standardOutput.write(Data("{\"ok\":true,\"backend\":\"memory-only\",\"keychainCalls\":0}\n".utf8))
    } else if CommandLine.arguments == [CommandLine.arguments[0], "--self-test-private-channels"] {
        try privateChannels()
        let preserved = dup(4)
        try require(preserved >= 0 && dup2(STDOUT_FILENO, 4) == 4, "SELF_TEST_FAILED")
        var aliasRejected = false
        do { try privateChannels() } catch { aliasRejected = true }
        try require(dup2(preserved, 4) == 4, "SELF_TEST_FAILED")
        close(preserved)
        try require(aliasRejected, "SELF_TEST_FAILED")
        FileHandle.standardOutput.write(Data("{\"ok\":true,\"backend\":\"private-pipes-only\",\"stdioAliasRejected\":true,\"keychainCalls\":0}\n".utf8))
    } else {
        try require(CommandLine.arguments == [CommandLine.arguments[0], "--activate-native-keychain-v1"], "ACTIVATION_REQUIRED")
        try require(ProcessInfo.processInfo.environment["NODE_TEST_CONTEXT"] == nil && ProcessInfo.processInfo.environment["MOTE_CUSTODY_TEST"] == nil, "NATIVE_FORBIDDEN_IN_TEST")
        let input = try readBounded(STDIN_FILENO, maximum: 1024)
        guard let object = try JSONSerialization.jsonObject(with: input) as? [String: Any] else { throw CustodyFailure(code: "INVALID_REQUEST") }
        let request = try Request(object)
        try realOperation(request)
        FileHandle.standardOutput.write(Data("{\"ok\":true}\n".utf8))
    }
} catch {
    // Never interpolate request data, framework diagnostics, key bytes or exceptions.
    FileHandle.standardOutput.write(Data("{\"ok\":false,\"code\":\"CUSTODY_OPERATION_REFUSED\"}\n".utf8))
    exit(1)
}
