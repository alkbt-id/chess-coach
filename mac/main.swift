// «Шахматный тренер» — native window around the local web UI.
// Starts the Python server (python -m coach) if it is not running, shows http://127.0.0.1:8737/
// in a WKWebView, and stops the server it started when the app quits.
import Cocoa
import WebKit

// The project folder: mac/build.sh writes it into Info.plist; COACH_ROOT sets it for a test build run outside the bundle.
let projectRoot = ProcessInfo.processInfo.environment["COACH_ROOT"]
    ?? (Bundle.main.object(forInfoDictionaryKey: "ChessCoachRoot") as? String) ?? ""
let port = Int(ProcessInfo.processInfo.environment["COACH_PORT"] ?? "") ?? 8737
let appURL = URL(string: "http://127.0.0.1:\(port)/")!
let pingURL = URL(string: "http://127.0.0.1:\(port)/api/ping")!
let logPath = NSHomeDirectory() + "/Library/Logs/chess-coach.log"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var loading = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1560, height: 960),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Шахматный тренер"
        window.minSize = NSSize(width: 1100, height: 680)
        window.contentView = web
        window.setFrameAutosaveName("ChessCoachMain2")
        if !window.setFrameUsingName("ChessCoachMain2") { window.center() }
        window.makeKeyAndOrderFront(nil)
        web.loadHTMLString(placeholder("Запускаю…"), baseURL: nil)
        ensureServer()
    }

    func ping(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: pingURL)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func ensureServer() {
        if loading { return }
        loading = true
        ping { ok in
            DispatchQueue.main.async {
                if ok { self.open() } else if self.startServer() { self.waitForServer(attempts: 120) }
            }
        }
    }

    func open() {
        loading = false
        web.load(URLRequest(url: appURL))
    }

    /// false (and a message in the window) when the server cannot be started
    func startServer() -> Bool {
        let python = projectRoot + "/.venv/bin/python"
        guard !projectRoot.isEmpty, FileManager.default.isExecutableFile(atPath: python) else {
            loading = false
            web.loadHTMLString(placeholder(projectRoot.isEmpty
                ? "Не знаю, где папка проекта: собери приложение заново через mac/build.sh"
                : "Нет \(python): выполни uv sync в папке проекта"), baseURL: nil)
            return false
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = ["-m", "coach"]
        p.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        if let h = FileHandle(forWritingAtPath: logPath) {
            h.seekToEndOfFile()
            p.standardOutput = h
            p.standardError = h
        }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        env["PYTHONUNBUFFERED"] = "1"
        p.environment = env
        do {
            try p.run()
            server = p
            return true
        } catch {
            loading = false
            web.loadHTMLString(placeholder("Не удалось запустить сервер: \(error.localizedDescription)"), baseURL: nil)
            return false
        }
    }

    func waitForServer(attempts: Int) {
        ping { ok in
            DispatchQueue.main.async {
                if ok { self.open(); return }
                if attempts <= 0 || self.server?.isRunning == false {
                    self.loading = false
                    self.web.loadHTMLString(self.placeholder("Сервер не запустился. Лог: ~/Library/Logs/chess-coach.log"), baseURL: nil)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForServer(attempts: attempts - 1) }
            }
        }
    }

    func placeholder(_ text: String) -> String {
        "<html><body style='font:15px -apple-system;color:#888;display:grid;place-items:center;height:90vh'>\(text)</body></html>"
    }

    // External links (Lichess) open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme?.hasPrefix("http") == true, url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // chess-coach://chat?id=<chat id>: come forward and open that chat (the Claude Limits menu bar app
    // sends it on a click). On a cold launch the page is not there yet, so the chat waits for it to load.
    var pendingChat: String?

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "chess-coach" && url.host == "chat" {
            let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value
            if let id, id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil { pendingChat = id }
        }
        if let window {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate()
        deliverPendingChat(loaded: web?.isLoading == false)
    }

    /// `loaded`: the page has finished loading (inside didFinish `isLoading` may still read true).
    /// The page's module script may run only after that, so when it is not there yet the id is left
    /// in `window.coachPendingChat` for it to pick up at the end of its start.
    func deliverPendingChat(loaded: Bool) {
        guard loaded, let id = pendingChat, let web, web.url?.host == "127.0.0.1" else { return }
        pendingChat = nil
        web.evaluateJavaScript("window.coachOpenChat ? void window.coachOpenChat('\(id)') : void (window.coachPendingChat = '\(id)')")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { deliverPendingChat(loaded: true) }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { ensureServer() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.ensureServer() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { server?.terminate() }

    @objc func reload() { web.reload() }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Скрыть «Шахматный тренер»", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Выйти", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Правка")
        edit.addItem(withTitle: "Копировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Выделить всё", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "Вид")
        let r = view.addItem(withTitle: "Обновить", action: #selector(reload), keyEquivalent: "r")
        r.target = self
        let fs = view.addItem(withTitle: "Во весь экран", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let win = NSMenu(title: "Окно")
        win.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Закрыть", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
