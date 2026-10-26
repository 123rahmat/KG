package kg.assist;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Keeps the assistant on firmware work. Requests are fixed task types about the open project;
 * the only free text is a short note, which is checked here. Replies are checked again before
 * they are shown, and code still has to pass the normal gates before it can be applied.
 *
 * This is a fixed rule set, not a model: it cannot be talked out of its rules.
 */
public final class Guard {
    private Guard() {
    }

    public static final int MAX_NOTE = 1500;

    private static final String[][] BLOCKED_TOPICS = {
        {"malware", "malware or harmful software"},
        {"ransomware", "malware or harmful software"},
        {"keylogger", "malware or harmful software"},
        {"key logger", "malware or harmful software"},
        {"spyware", "malware or harmful software"},
        {"rootkit", "malware or harmful software"},
        {"botnet", "malware or harmful software"},
        {"trojan", "malware or harmful software"},
        {"virus", "malware or harmful software"},
        {"worm that", "malware or harmful software"},
        {"backdoor", "hidden access"},
        {"shellcode", "exploit code"},
        {"exploit", "exploit code"},
        {"privilege escalation", "exploit code"},
        {"bypass auth", "getting around security"},
        {"bypass the license", "getting around licensing"},
        {"crack the", "getting around licensing"},
        {"license key generator", "getting around licensing"},
        {"keygen", "getting around licensing"},
        {"drm", "getting around licensing"},
        {"steal", "theft of data or credentials"},
        {"password dump", "theft of data or credentials"},
        {"credential", "theft of data or credentials"},
        {"phishing", "fraud"},
        {"ddos", "attacks on other systems"},
        {"denial of service", "attacks on other systems"},
        {"jammer", "illegal radio interference"},
        {"jamming", "illegal radio interference"},
        {"detonat", "weapons"},
        {"explosive", "weapons"},
        {"warhead", "weapons"},
        {"weapon", "weapons"},
        {"firearm", "weapons"},
        {"tracking someone", "covert tracking of people"},
        {"track a person", "covert tracking of people"},
        {"hidden camera", "covert surveillance"},
        {"disable the safety", "disabling safety functions"},
        {"remove the safety", "disabling safety functions"},
        {"defeat device", "emissions or safety cheating"},
        {"cheat the emission", "emissions or safety cheating"},
        {"odometer", "tampering with records"},
    };

    /** Constructs firmware for this product must never contain, whatever the request. */
    private static final Pattern FORBIDDEN_CODE = Pattern.compile(
            "\\b(socket|connect|getaddrinfo|gethostbyname|WSAStartup|InternetOpen|URLDownloadToFile|curl_easy|"
            + "system|popen|execv|execl|execve|fork|CreateProcess|WinExec|ShellExecute|LoadLibrary|dlopen|"
            + "VirtualAlloc|VirtualProtect|mprotect|ptrace|keybd_event|SetWindowsHookEx|GetAsyncKeyState|"
            + "unlink|remove|rmdir|DeleteFile)\\s*\\(|https?://|import\\s+(socket|requests|urllib|http)|"
            + "subprocess|os\\.system|eval\\s*\\(|exec\\s*\\(|"
            + "(import|from)\\s+(ctypes|shutil|multiprocessing|threading|asyncio|ftplib|smtplib|telnetlib|socketserver|"
            + "ssl|signal|pty|webbrowser|importlib|pickle|marshal)\\b|__import__|compile\\s*\\(|"
            + "open\\s*\\([^,)]*,\\s*(mode\\s*=\\s*)?['\"][^'\"]*[wax+][^'\"]*['\"]|open\\s*\\([^)]*mode\\s*=\\s*['\"][^'\"]*[wax+]|os\\.(kill|popen|spawn\\w*|exec\\w*|chmod|chown|rename|replace)\\b|"
            + "\\.write_(text|bytes)\\s*\\(");

    /** Returns why a note is refused, or null when it is fine. */
    public static String checkNote(String note) {
        if (note == null || note.isBlank()) {
            return null;
        }
        if (note.length() > MAX_NOTE) {
            return "The note is longer than " + MAX_NOTE + " characters. Keep it to what this task needs.";
        }
        String n = note.toLowerCase(Locale.ROOT);
        for (String[] b : BLOCKED_TOPICS) {
            if (n.contains(b[0])) {
                return "The assistant only helps with this project's firmware and tests. It will not help with " + b[1] + ".";
            }
        }
        return null;
    }

    /** Problems in generated text or code, empty when it may be shown. */
    public static List<String> checkReply(String text) {
        List<String> p = new ArrayList<>();
        java.util.regex.Matcher m = FORBIDDEN_CODE.matcher(text);
        while (m.find() && p.size() < 5) {
            p.add("uses '" + m.group().strip() + "', which firmware in Kindgleam may not use (no network, processes, "
                    + "file deletion or code loading)");
        }
        String low = text.toLowerCase(Locale.ROOT);
        for (String[] b : BLOCKED_TOPICS) {
            if (low.contains(b[0]) && !b[0].equals("exploit") && !b[0].equals("virus")) {
                p.add("mentions " + b[1]);
                break;
            }
        }
        return p;
    }
}
