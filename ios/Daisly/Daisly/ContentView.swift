import SwiftUI
import StoreKit
import UIKit
import UserNotifications
import WebKit

struct ContentView: View {
    @State private var splashVisible = true
    @State private var splashLeaving = false
    @State private var webViewReady = false
    @State private var minimumSplashTimePassed = false

    var body: some View {
        ZStack {
            DaislyWebView {
                webViewReady = true
                dismissSplashIfReady()
            }
            .ignoresSafeArea()

            if splashVisible {
                DaislyLaunchSplash(isReady: webViewReady, isLeaving: splashLeaving)
                    .ignoresSafeArea()
                    .transition(.opacity)
            }
        }
        .background(Color.daislyPaper)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.35) {
                minimumSplashTimePassed = true
                dismissSplashIfReady()
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + 3.6) {
                webViewReady = true
                dismissSplashIfReady()
            }
        }
    }

    private func dismissSplashIfReady() {
        guard splashVisible, !splashLeaving, webViewReady, minimumSplashTimePassed else { return }

        withAnimation(.easeInOut(duration: 0.88)) {
            splashLeaving = true
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            splashVisible = false
        }
    }
}

struct DaislyWebView: UIViewRepresentable {
    private static let nativeStorageKey = "DaislyNativeSnapshot"

    let onReady: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onReady: onReady)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            document.documentElement.classList.add('native-app');
            window.__DAISLY_NATIVE__ = true;
            window.__DAISLY_NATIVE_STATE__ = \(Self.nativeStorageJSON());
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController.add(context.coordinator, name: "daislyHaptic")
        configuration.userContentController.add(context.coordinator, name: "daislyStorage")
        configuration.userContentController.add(context.coordinator, name: "daislyNotifications")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.96, green: 0.97, blue: 0.96, alpha: 1)
        webView.navigationDelegate = context.coordinator
        UNUserNotificationCenter.current().delegate = context.coordinator

        if let localURL = Bundle.main.daislyLocalWebAppURL {
            webView.loadFileURL(localURL, allowingReadAccessTo: localURL.deletingLastPathComponent())
        } else if let url = Bundle.main.daislyWebAppURL {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private static func nativeStorageJSON() -> String {
        guard
            let value = UserDefaults.standard.string(forKey: nativeStorageKey),
            let data = value.data(using: .utf8),
            (try? JSONSerialization.jsonObject(with: data)) != nil
        else {
            return "null"
        }

        return value
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, UNUserNotificationCenterDelegate {
        private let monthlyProductID = "daisly_pro_monthly"
        private let yearlyProductID = "daisly_pro_yearly"
        private let notificationPrefix = "daisly-task-"
        var onReady: () -> Void
        private var didNotifyReady = false

        init(onReady: @escaping () -> Void) {
            self.onReady = onReady
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            switch message.name {
            case "daislyHaptic":
                handleHaptic(message.body)
            case "daislyStorage":
                handleStorage(message.body)
            case "daislyNotifications":
                handleNotifications(message.body)
            default:
                break
            }
        }

        private func handleHaptic(_ body: Any) {
            let level = body as? String
            let style: UIImpactFeedbackGenerator.FeedbackStyle = level == "medium" ? .medium : .light
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.prepare()
            generator.impactOccurred()
        }

        private func handleStorage(_ body: Any) {
            guard JSONSerialization.isValidJSONObject(body),
                  let data = try? JSONSerialization.data(withJSONObject: body),
                  let value = String(data: data, encoding: .utf8)
            else {
                return
            }

            UserDefaults.standard.set(value, forKey: DaislyWebView.nativeStorageKey)
        }

        private func handleNotifications(_ body: Any) {
            guard
                let payload = body as? [String: Any],
                let action = payload["action"] as? String
            else {
                return
            }

            switch action {
            case "sync":
                syncNotifications(from: payload["items"] as? [[String: Any]] ?? [])
            case "cancelAll":
                cancelDaislyNotifications()
            case "request":
                requestNotificationAuthorization { _ in }
            default:
                break
            }
        }

        private func syncNotifications(from rawItems: [[String: Any]]) {
            let items = notificationItems(from: rawItems)
            guard !items.isEmpty else {
                cancelDaislyNotifications()
                return
            }

            requestNotificationAuthorization { [weak self] allowed in
                guard let self else { return }
                guard allowed else {
                    self.cancelDaislyNotifications()
                    return
                }

                let center = UNUserNotificationCenter.current()
                center.getPendingNotificationRequests { requests in
                    let oldIDs = requests.map(\.identifier).filter { $0.hasPrefix(self.notificationPrefix) }
                    center.removePendingNotificationRequests(withIdentifiers: oldIDs)

                    items.prefix(60).forEach { item in
                        let content = UNMutableNotificationContent()
                        content.title = item.title
                        content.body = item.body
                        content.sound = .default
                        content.interruptionLevel = .active

                        let components = Calendar.current.dateComponents(
                            [.year, .month, .day, .hour, .minute, .second],
                            from: item.fireDate
                        )
                        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
                        center.add(UNNotificationRequest(identifier: item.identifier, content: content, trigger: trigger))
                    }
                }
            }
        }

        private func cancelDaislyNotifications() {
            let center = UNUserNotificationCenter.current()
            center.getPendingNotificationRequests { [notificationPrefix] requests in
                let ids = requests.map(\.identifier).filter { $0.hasPrefix(notificationPrefix) }
                center.removePendingNotificationRequests(withIdentifiers: ids)
            }
        }

        private func requestNotificationAuthorization(completion: @escaping (Bool) -> Void) {
            let center = UNUserNotificationCenter.current()
            center.getNotificationSettings { settings in
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    completion(true)
                case .notDetermined:
                    center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                        completion(granted)
                    }
                default:
                    completion(false)
                }
            }
        }

        private func notificationItems(from rawItems: [[String: Any]]) -> [NativeNotificationItem] {
            let now = Date().addingTimeInterval(5)
            return rawItems.compactMap { raw in
                guard
                    let rawID = raw["id"] as? String,
                    let title = raw["title"] as? String
                else {
                    return nil
                }

                let numericDate = (raw["fireDate"] as? NSNumber)?.doubleValue ?? raw["fireDate"] as? Double ?? 0
                let timestamp = numericDate > 10_000_000_000 ? numericDate / 1000 : numericDate
                let fireDate = Date(timeIntervalSince1970: timestamp)
                guard fireDate > now else { return nil }

                let identifier = rawID.hasPrefix(notificationPrefix) ? rawID : notificationPrefix + rawID
                return NativeNotificationItem(
                    identifier: identifier,
                    title: title,
                    body: raw["body"] as? String ?? "",
                    fireDate: fireDate
                )
            }
            .sorted { $0.fireDate < $1.fireDate }
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification,
            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
        ) {
            completionHandler([.banner, .sound])
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            notifyReady()
            Task { await publishStoreProducts(to: webView) }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            notifyReady()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            notifyReady()
        }

        private func notifyReady() {
            guard !didNotifyReady else { return }
            didNotifyReady = true

            DispatchQueue.main.async {
                self.onReady()
            }
        }

        private func publishStoreProducts(to webView: WKWebView) async {
            do {
                let products = try await Product.products(for: [monthlyProductID, yearlyProductID])
                let monthly = products.first(where: { $0.id == monthlyProductID })
                let yearly = products.first(where: { $0.id == yearlyProductID })
                let payload = StoreProductsPayload(
                    monthly: productPayload(from: monthly, period: "month"),
                    yearly: productPayload(from: yearly, period: "year", monthlyEquivalent: monthlyEquivalent(for: yearly))
                )
                await MainActor.run { inject(payload, into: webView) }
            } catch {
                await MainActor.run { inject(StoreProductsPayload(monthly: nil, yearly: nil), into: webView) }
            }
        }

        private func productPayload(from product: Product?, period: String, monthlyEquivalent: String? = nil) -> StoreProductPayload? {
            guard let product else { return nil }
            return StoreProductPayload(
                id: product.id,
                displayName: product.displayName,
                displayPrice: product.displayPrice,
                period: period,
                monthlyEquivalent: monthlyEquivalent
            )
        }

        private func monthlyEquivalent(for product: Product?) -> String? {
            guard let product else { return nil }
            let divided = NSDecimalNumber(decimal: product.price).dividing(by: NSDecimalNumber(value: 12)).decimalValue
            return divided.formatted(product.priceFormatStyle)
        }

        @MainActor
        private func inject(_ payload: StoreProductsPayload, into webView: WKWebView) {
            guard
                let data = try? JSONEncoder().encode(payload),
                let json = String(data: data, encoding: .utf8)
            else { return }

            let script = """
            window.__DAISLY_PRODUCT_PRICES__ = \(json);
            window.dispatchEvent(new CustomEvent('daislyProductPrices', { detail: window.__DAISLY_PRODUCT_PRICES__ }));
            """
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private struct StoreProductsPayload: Codable {
        let monthly: StoreProductPayload?
        let yearly: StoreProductPayload?
    }

    private struct StoreProductPayload: Codable {
        let id: String
        let displayName: String
        let displayPrice: String
        let period: String
        let monthlyEquivalent: String?
    }

    private struct NativeNotificationItem {
        let identifier: String
        let title: String
        let body: String
        let fireDate: Date
    }
}

private struct DaislyLaunchSplash: View {
    let isReady: Bool
    let isLeaving: Bool

    @State private var appeared = false
    @State private var breathe = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(hex: "#F8FFF9"),
                    Color(hex: "#F3FAF4"),
                    Color(hex: "#FFF5ED")
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack {
                Spacer(minLength: 0)

                ZStack {
                    DaislyAnimatedLogo(animate: breathe, appeared: appeared)
                        .frame(width: 108, height: 108)
                        .shadow(color: Color.daislySage.opacity(0.2), radius: 24, x: 0, y: 18)
                }
                .scaleEffect(appeared ? (breathe ? 1.018 : 0.996) : 0.9)
                .opacity(appeared ? 1 : 0)
                .animation(.spring(response: 0.74, dampingFraction: 0.86), value: appeared)
                .animation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true), value: breathe)

                Spacer(minLength: 0)
            }
            .opacity(appeared ? 1 : 0)
            .animation(.spring(response: 0.78, dampingFraction: 0.84), value: appeared)
        }
        .opacity(isLeaving ? 0 : 1)
        .scaleEffect(isLeaving ? 1.025 : 1)
        .blur(radius: isLeaving ? 8 : 0)
        .animation(.easeInOut(duration: 0.88), value: isLeaving)
        .onAppear {
            withAnimation(.easeOut(duration: 0.48).delay(0.04)) {
                appeared = true
            }

            withAnimation(.easeInOut(duration: 1.9).repeatForever(autoreverses: true)) {
                breathe = true
            }
        }
    }
}

private struct LaunchHeader: View {
    let breathe: Bool

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.ultraThinMaterial)
                .frame(width: 56, height: 56)
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Color.white.opacity(0.82), lineWidth: 1)
                )
                .shadow(color: Color.daislySage.opacity(0.16), radius: 18, x: 0, y: 12)
                .overlay {
                    DaislyMark(animate: breathe)
                        .scaleEffect(0.58)
                }

            VStack(alignment: .leading, spacing: 4) {
                Text("Daisly")
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.daislyInk)

                Text("A calmer plan for today")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.daislyInk.opacity(0.52))
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: 342)
        .scaleEffect(breathe ? 1.008 : 1)
    }
}

private struct LaunchPlanCard: View {
    let showPlan: Bool
    let sweep: Bool
    let isReady: Bool

    var body: some View {
        VStack(spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Today")
                        .font(.system(size: 18, weight: .heavy, design: .rounded))
                        .foregroundStyle(Color.daislyInk)

                    Text("Open time turns into a plan")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.daislyInk.opacity(0.46))
                }

                Spacer(minLength: 0)

                LaunchStatusPill(isReady: isReady)
            }

            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.daislySage.opacity(0.0),
                                Color.daislySage.opacity(0.28),
                                Color.daislyLagoon.opacity(0.22),
                                Color.daislySage.opacity(0.0)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: 3)
                    .padding(.vertical, 28)
                    .offset(x: 61)

                VStack(spacing: 13) {
                    ForEach(LaunchPlanItem.all) { item in
                        LaunchTimelineRow(item: item, showPlan: showPlan)
                            .opacity(showPlan ? 1 : 0)
                            .offset(x: showPlan ? 0 : 14)
                            .scaleEffect(showPlan ? 1 : 0.985, anchor: .leading)
                            .animation(.spring(response: 0.72, dampingFraction: 0.88).delay(item.delay), value: showPlan)
                    }
                }

                LaunchSweepLine(isReady: isReady)
                    .offset(y: sweep ? 118 : -116)
                    .opacity(showPlan ? 1 : 0)
            }
            .frame(height: 248)
            .clipped()

            LaunchPlanProgress(isReady: isReady, showPlan: showPlan)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .stroke(Color.white.opacity(0.78), lineWidth: 1)
                )
        )
        .shadow(color: Color.daislySage.opacity(0.14), radius: 32, x: 0, y: 22)
    }
}

private struct LaunchSimplePlanCard: View {
    let showPlan: Bool
    let sweep: Bool
    let isReady: Bool

    var body: some View {
        VStack(spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Today is taking shape")
                        .font(.system(size: 19, weight: .heavy, design: .rounded))
                        .foregroundStyle(Color.daislyInk)

                    Text("Daisly finds the open spaces")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.daislyInk.opacity(0.46))
                }

                Spacer(minLength: 0)

                LaunchStatusPill(isReady: isReady)
            }

            LaunchDayRibbon(showPlan: showPlan, sweep: sweep, isReady: isReady)
                .frame(height: 44)

            VStack(spacing: 10) {
                ForEach(LaunchSimpleItem.all) { item in
                    LaunchSimpleRow(item: item, showPlan: showPlan)
                        .opacity(showPlan ? 1 : 0)
                        .offset(y: showPlan ? 0 : 10)
                        .animation(.spring(response: 0.72, dampingFraction: 0.9).delay(item.delay), value: showPlan)
                }
            }

            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill(Color.daislySage.opacity(0.12))
                        .frame(width: 32, height: 32)

                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundStyle(Color.daislySage)
                }

                Text(isReady ? "Your plan is ready" : "Making room for what matters")
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.daislyInk.opacity(0.68))

                Spacer(minLength: 0)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.white.opacity(0.54))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Color.white.opacity(0.82), lineWidth: 1)
                    )
            )
            .opacity(showPlan ? 1 : 0)
            .scaleEffect(showPlan ? 1 : 0.98)
            .animation(.spring(response: 0.72, dampingFraction: 0.88).delay(0.62), value: showPlan)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .stroke(Color.white.opacity(0.8), lineWidth: 1)
                )
        )
        .shadow(color: Color.daislySage.opacity(0.13), radius: 30, x: 0, y: 22)
    }
}

private struct LaunchDayRibbon: View {
    let showPlan: Bool
    let sweep: Bool
    let isReady: Bool

    var body: some View {
        VStack(spacing: 9) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule(style: .continuous)
                        .fill(Color.daislyInk.opacity(0.075))

                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.daislySage,
                                    Color.daislyLagoon,
                                    Color(hex: "#C08B68")
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: showPlan ? proxy.size.width * (isReady ? 0.94 : (sweep ? 0.76 : 0.34)) : 0)
                        .animation(.easeInOut(duration: 1.55), value: sweep)
                        .animation(.spring(response: 0.74, dampingFraction: 0.86).delay(0.18), value: showPlan)

                    HStack {
                        ForEach(0..<4, id: \.self) { index in
                            Circle()
                                .fill(Color.white)
                                .frame(width: 8, height: 8)
                                .shadow(color: Color.daislyInk.opacity(0.08), radius: 5, x: 0, y: 3)

                            if index < 3 {
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
            .frame(height: 12)

            HStack {
                Text("Morning")
                Spacer(minLength: 0)
                Text("Noon")
                Spacer(minLength: 0)
                Text("Evening")
            }
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .foregroundStyle(Color.daislyInk.opacity(0.38))
        }
    }
}

private struct LaunchSimpleRow: View {
    let item: LaunchSimpleItem
    let showPlan: Bool

    var body: some View {
        HStack(spacing: 11) {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(item.color.opacity(0.14))
                .frame(width: 38, height: 38)
                .overlay {
                    Image(systemName: item.symbol)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(item.color)
                }

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.system(size: 14, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.daislyInk)
                    .lineLimit(1)

                Text(item.subtitle)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.daislyInk.opacity(0.44))
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            Text(item.time)
                .font(.system(size: 11, weight: .heavy, design: .rounded))
                .foregroundStyle(item.color)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    Capsule(style: .continuous)
                        .fill(item.color.opacity(0.12))
                )
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.white.opacity(0.78))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(Color.white.opacity(0.9), lineWidth: 1)
                )
        )
        .shadow(color: item.color.opacity(showPlan ? 0.11 : 0), radius: 14, x: 0, y: 10)
    }
}

private struct LaunchTimelineRow: View {
    let item: LaunchPlanItem
    let showPlan: Bool

    var body: some View {
        HStack(spacing: 12) {
            Text(item.time)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(Color.daislyInk.opacity(0.48))
                .frame(width: 42, alignment: .trailing)

            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.98))
                    .frame(width: 18, height: 18)

                Circle()
                    .fill(item.isFree ? Color.daislyLagoon : item.color)
                    .frame(width: item.isFree ? 7 : 9, height: item.isFree ? 7 : 9)
            }
            .shadow(color: item.color.opacity(0.18), radius: 8, x: 0, y: 6)

            if item.isFree {
                LaunchFreeSlot(item: item)
            } else {
                LaunchTaskCard(item: item)
            }
        }
        .frame(height: item.height)
    }
}

private struct LaunchTaskCard: View {
    let item: LaunchPlanItem

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(item.color.opacity(0.14))
                .frame(width: 36, height: 36)
                .overlay {
                    Image(systemName: item.symbol)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(item.color)
                }

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.system(size: 14, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.daislyInk)
                    .lineLimit(1)

                Text(item.subtitle)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.daislyInk.opacity(0.45))
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13)
        .background(
            RoundedRectangle(cornerRadius: 21, style: .continuous)
                .fill(Color.white.opacity(0.82))
                .overlay(
                    RoundedRectangle(cornerRadius: 21, style: .continuous)
                        .stroke(Color.white.opacity(0.9), lineWidth: 1)
                )
        )
        .shadow(color: item.color.opacity(0.12), radius: 14, x: 0, y: 10)
    }
}

private struct LaunchFreeSlot: View {
    let item: LaunchPlanItem

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.daislyLagoon)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.daislyInk.opacity(0.76))

                Text(item.subtitle)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.daislyInk.opacity(0.4))
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.44))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(style: StrokeStyle(lineWidth: 1.4, dash: [5, 6]))
                        .foregroundStyle(Color.daislyLagoon.opacity(0.42))
                )
        )
    }
}

private struct LaunchSweepLine: View {
    let isReady: Bool

    var body: some View {
        Capsule(style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        Color.clear,
                        isReady ? Color.daislySage.opacity(0.68) : Color.daislyLagoon.opacity(0.62),
                        Color.clear
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .frame(height: 3)
            .shadow(color: Color.daislySage.opacity(0.22), radius: 10, x: 0, y: 0)
    }
}

private struct LaunchStatusPill: View {
    let isReady: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(isReady ? Color.daislySage : Color.daislyLagoon)
                .frame(width: 8, height: 8)

            Text(isReady ? "Ready" : "Arranging")
                .font(.system(size: 12, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.daislyInk.opacity(0.68))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.74))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(Color.white.opacity(0.86), lineWidth: 1)
                )
        )
    }
}

private struct LaunchPlanProgress: View {
    let isReady: Bool
    let showPlan: Bool

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<4, id: \.self) { index in
                Capsule(style: .continuous)
                    .fill(index == 3 && !isReady ? Color.daislyInk.opacity(0.1) : Color.daislySage.opacity(index == 0 ? 0.92 : 0.42))
                    .frame(height: 5)
                    .frame(maxWidth: index == 0 ? 46 : .infinity)
                    .scaleEffect(x: showPlan ? 1 : 0.2, y: 1, anchor: .leading)
                    .animation(.easeOut(duration: 0.5).delay(0.28 + Double(index) * 0.08), value: showPlan)
            }
        }
        .opacity(0.85)
    }
}

private struct DaislyMark: View {
    let animate: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            capsule(height: animate ? 34 : 26, color: Color.daislyLagoon.opacity(0.68))
            capsule(height: animate ? 52 : 42, color: Color.daislySage)
            capsule(height: animate ? 30 : 22, color: Color.daislyLagoon.opacity(0.62))
        }
        .animation(.spring(response: 0.82, dampingFraction: 0.72), value: animate)
    }

    private func capsule(height: CGFloat, color: Color) -> some View {
        Capsule(style: .continuous)
            .fill(color)
            .frame(width: 14, height: height)
            .shadow(color: color.opacity(0.22), radius: 8, x: 0, y: 8)
    }
}

private struct DaislyAnimatedLogo: View {
    let animate: Bool
    let appeared: Bool

    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            let sideWidth = size * 0.154
            let sideHeight = size * 0.325
            let centerHeight = size * 0.537
            let corner = size * 0.235

            ZStack {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "#E5F0EA"),
                                Color(hex: "#DCE8E1"),
                                Color(hex: "#F7FBF8")
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: corner, style: .continuous)
                            .stroke(Color.white.opacity(0.46), lineWidth: 1)
                    )
                    .shadow(color: Color.daislySage.opacity(0.1), radius: 12, x: 0, y: 7)

                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(
                        RadialGradient(
                            colors: [
                                Color.white.opacity(0.42),
                                Color.clear
                            ],
                            center: .topLeading,
                            startRadius: size * 0.02,
                            endRadius: size * 0.78
                        )
                    )

                logoCapsule(
                    width: sideWidth,
                    height: sideHeight,
                    color: Color(hex: "#97BAA8"),
                    delay: 0.08,
                    float: 0.9
                )
                .position(x: size * 0.275, y: size * 0.541)

                logoCapsule(
                    width: sideWidth,
                    height: sideHeight,
                    color: Color(hex: "#97BAA8"),
                    delay: 0.16,
                    float: -0.8
                )
                .position(x: size * 0.734, y: size * 0.541)

                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "#468464"),
                                Color(hex: "#8EBAA2"),
                                Color.white.opacity(0.94)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: sideWidth, height: appeared ? centerHeight : centerHeight * 0.68)
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(Color.white.opacity(0.26), lineWidth: 1)
                    )
                    .position(x: size * 0.504, y: appeared ? size * 0.503 : size * 0.545)
                    .scaleEffect(y: appeared ? (animate ? 1 : 0.975) : 0.62, anchor: .bottom)
                    .offset(y: animate ? -0.8 : 0.8)
                    .shadow(color: Color.daislySage.opacity(0.16), radius: 8, x: 0, y: 6)
                    .animation(.spring(response: 0.86, dampingFraction: 0.82).delay(0.16), value: appeared)
                    .animation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true), value: animate)
            }
            .frame(width: size, height: size)
            .opacity(appeared ? 1 : 0)
            .scaleEffect(appeared ? 1 : 0.96)
        }
        .aspectRatio(1, contentMode: .fit)
    }

    private func logoCapsule(width: CGFloat, height: CGFloat, color: Color, delay: Double, float: CGFloat) -> some View {
        Capsule(style: .continuous)
            .fill(color)
            .frame(width: width, height: appeared ? height : height * 0.62)
            .overlay(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.16),
                                Color.clear,
                                Color.daislyInk.opacity(0.05)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            )
            .scaleEffect(y: appeared ? 1 : 0.7, anchor: .bottom)
            .opacity(appeared ? 1 : 0)
            .offset(y: animate ? float : -float)
            .shadow(color: color.opacity(0.18), radius: 7, x: 0, y: 5)
            .animation(.spring(response: 0.76, dampingFraction: 0.82).delay(delay), value: appeared)
            .animation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true).delay(delay), value: animate)
    }
}

private struct LaunchPlanItem: Identifiable {
    let id = UUID()
    let time: String
    let title: String
    let subtitle: String
    let symbol: String
    let color: Color
    let isFree: Bool
    let height: CGFloat
    let delay: Double

    static let all: [LaunchPlanItem] = [
        LaunchPlanItem(
            time: "08:00",
            title: "Morning routine",
            subtitle: "Start the day",
            symbol: "sun.max.fill",
            color: Color(hex: "#C08B68"),
            isFree: false,
            height: 56,
            delay: 0.2
        ),
        LaunchPlanItem(
            time: "09:30",
            title: "Deep work",
            subtitle: "90 min focus block",
            symbol: "pencil.and.outline",
            color: Color.daislySage,
            isFree: false,
            height: 66,
            delay: 0.34
        ),
        LaunchPlanItem(
            time: "11:15",
            title: "Free slot",
            subtitle: "45 min available",
            symbol: "sparkles",
            color: Color.daislyLagoon,
            isFree: true,
            height: 50,
            delay: 0.48
        ),
        LaunchPlanItem(
            time: "12:30",
            title: "Team sync",
            subtitle: "Calendar protected",
            symbol: "person.2.fill",
            color: Color.daislyLagoon,
            isFree: false,
            height: 56,
            delay: 0.62
        )
    ]
}

private struct LaunchSimpleItem: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let time: String
    let symbol: String
    let color: Color
    let delay: Double

    static let all: [LaunchSimpleItem] = [
        LaunchSimpleItem(
            title: "Focus block",
            subtitle: "Protected work time",
            time: "09:30",
            symbol: "target",
            color: Color.daislySage,
            delay: 0.28
        ),
        LaunchSimpleItem(
            title: "Open window",
            subtitle: "Space for a new task",
            time: "11:15",
            symbol: "plus",
            color: Color.daislyLagoon,
            delay: 0.42
        ),
        LaunchSimpleItem(
            title: "Evening buffer",
            subtitle: "No rush at the end",
            time: "18:00",
            symbol: "moon.fill",
            color: Color(hex: "#C08B68"),
            delay: 0.56
        )
    ]
}

private extension Color {
    static let daislySage = Color(hex: "#2E8B57")
    static let daislyLagoon = Color(hex: "#5F9EA0")
    static let daislyInk = Color(hex: "#17211B")
    static let daislyPaper = Color(hex: "#F5F8F5")

    init(hex: String) {
        let value = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: value).scanHexInt64(&int)

        let red: UInt64
        let green: UInt64
        let blue: UInt64

        switch value.count {
        case 6:
            red = (int >> 16) & 0xff
            green = (int >> 8) & 0xff
            blue = int & 0xff
        default:
            red = 0
            green = 0
            blue = 0
        }

        self.init(
            .sRGB,
            red: Double(red) / 255,
            green: Double(green) / 255,
            blue: Double(blue) / 255,
            opacity: 1
        )
    }
}

private extension Bundle {
    var daislyLocalWebAppURL: URL? {
        url(forResource: "index", withExtension: "html", subdirectory: "web")
    }

    var daislyWebAppURL: URL? {
        let value = object(forInfoDictionaryKey: "DaislyWebAppURL") as? String
        return value.flatMap(URL.init(string:))
    }
}
