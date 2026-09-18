// MDSyncView tray host (Windows). Compiled with the .NET Framework C# compiler that ships with Windows
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe, C# 5 syntax only), so no SDK install is needed.
//
// Responsibilities:
//   * start the MDSyncView server without a console window and keep it alive while the tray icon exists
//   * show a notification-area icon with a menu: open UI, open in browser, rescan, data folder, log, quit
//   * open the UI (Edge/Chrome app window via the server) once the server answers /api/health
//   * shut the server down gracefully on Quit; restart it (up to 3 times) if it crashes
//
// Server discovery: --server-exe=<path>, else MDSyncView-server.exe next to this exe (release layout),
// else `node <repo>\server\src\index.ts` when running from dist\tray\ inside the source tree.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MDSyncView
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\MDSyncView.Tray", out createdNew))
            {
                if (!createdNew)
                {
                    // second launch: just bring the UI up on the running instance
                    TrayApp.PostToServer(TrayApp.ParsePort(args), "/api/open-ui");
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(args));
                GC.KeepAlive(mutex);
            }
        }
    }

    class TrayApp : ApplicationContext
    {
        const int DefaultPort = 4820;
        const int MaxRestarts = 3;

        readonly NotifyIcon icon;
        readonly ContextMenuStrip menu;
        readonly System.Windows.Forms.Timer watchdog;
        readonly List<string> serverArgs = new List<string>();
        readonly string dataDir;
        readonly string logPath;
        /** Requested port; replaced by the effective one once the server logs "listening on" (it moves on when busy). */
        int port;
        string serverExe;
        string serverWorkDir;
        Process server;
        StreamWriter log;
        bool quitting;
        bool uiOpened;
        /** --tray-no-ui: never open the app window automatically (used by automated tests). */
        readonly bool noAutoUi;
        int restarts;
        DateTime serverStartedAt;

        public TrayApp(string[] args)
        {
            port = ParsePort(args);
            string data = ArgValue(args, "data");
            dataDir = string.IsNullOrEmpty(data)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MDSyncView")
                : data;
            Directory.CreateDirectory(dataDir);
            logPath = Path.Combine(dataDir, "server.log");
            foreach (string a in args)
            {
                if (a.StartsWith("--server-exe=", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(a, "--tray-no-ui", StringComparison.OrdinalIgnoreCase)) { noAutoUi = true; continue; }
                serverArgs.Add(a);
            }
            if (!serverArgs.Contains("--no-open")) serverArgs.Add("--no-open");
            ResolveServer(ArgValue(args, "server-exe"));

            menu = new ContextMenuStrip();
            ToolStripMenuItem open = new ToolStripMenuItem("打开 MDSyncView", null, delegate { OpenUi(); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripMenuItem("在浏览器中打开", null, delegate { StartShell(Url("/")); }));
            menu.Items.Add(new ToolStripMenuItem("重新扫描全部根目录", null, delegate
            {
                if (PostToServer(port, "/api/rescan")) Balloon("已开始重新扫描", "MDSyncView 正在核对所有根目录。", ToolTipIcon.Info);
                else Balloon("服务未响应", "无法请求重新扫描，请查看日志。", ToolTipIcon.Warning);
            }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("打开数据目录", null, delegate { StartShell(dataDir); }));
            menu.Items.Add(new ToolStripMenuItem("查看服务日志", null, delegate { if (File.Exists(logPath)) StartShell(logPath); }));
            menu.Items.Add(new ToolStripMenuItem("重启服务", null, delegate { RestartServer("手动重启"); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("退出 MDSyncView", null, delegate { Quit(); }));

            icon = new NotifyIcon();
            icon.Icon = LoadIcon();
            icon.Text = "MDSyncView · 127.0.0.1:" + port;
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenUi(); };
            icon.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenUi(); };
            icon.BalloonTipClicked += delegate { OpenUi(); };
            icon.Visible = true;

            watchdog = new System.Windows.Forms.Timer();
            watchdog.Interval = 500;
            watchdog.Tick += delegate { Tick(); };

            StartServer();
            watchdog.Start();
        }

        // ---- server process ------------------------------------------------------------------------

        void ResolveServer(string explicitExe)
        {
            string here = AppDomain.CurrentDomain.BaseDirectory;
            if (!string.IsNullOrEmpty(explicitExe) && File.Exists(explicitExe))
            {
                serverExe = explicitExe;
                serverWorkDir = Path.GetDirectoryName(explicitExe);
                return;
            }
            string packaged = Path.Combine(here, "MDSyncView-server.exe");
            if (File.Exists(packaged))
            {
                serverExe = packaged;
                serverWorkDir = here;
                return;
            }
            // source tree layout: <repo>\dist\tray\MDSyncView.exe → <repo>\server\src\index.ts via node
            string repo = Path.GetFullPath(Path.Combine(here, "..", ".."));
            string entry = Path.Combine(repo, "server", "src", "index.ts");
            if (File.Exists(entry))
            {
                serverExe = "node";
                serverWorkDir = repo;
                serverArgs.Insert(0, entry);
                serverArgs.Insert(0, "--no-warnings=ExperimentalWarning");
                return;
            }
            MessageBox.Show("找不到 MDSyncView-server.exe（应与本程序位于同一目录）。", "MDSyncView", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.Exit(2);
        }

        void StartServer()
        {
            try
            {
                OpenLog();
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = serverExe;
                psi.Arguments = JoinArgs(serverArgs);
                psi.WorkingDirectory = serverWorkDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["MDSYNCVIEW_TRAY"] = "1";
                server = new Process();
                server.StartInfo = psi;
                server.EnableRaisingEvents = true;
                server.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { WriteLog(e.Data); NoteListening(e.Data); };
                server.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { WriteLog(e.Data); NoteListening(e.Data); };
                server.Exited += delegate { OnServerExited(); };
                server.Start();
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
                serverStartedAt = DateTime.UtcNow;
                uiOpened = false;
                WriteLog("[tray] started " + serverExe + " " + psi.Arguments + " (pid " + server.Id + ")");
            }
            catch (Exception ex)
            {
                WriteLog("[tray] failed to start server: " + ex.Message);
                MessageBox.Show("无法启动 MDSyncView 服务：\n" + ex.Message + "\n\n日志：" + logPath, "MDSyncView", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Quit();
            }
        }

        void OnServerExited()
        {
            int code = -1;
            try { code = server.ExitCode; } catch { }
            WriteLog("[tray] server exited with code " + code);
            if (quitting) return;
            // marshal back to the UI thread
            try { menu.BeginInvoke(new Action(delegate { HandleServerExit(code); })); }
            catch { HandleServerExit(code); }
        }

        void HandleServerExit(int code)
        {
            if (quitting) return;
            double uptime = (DateTime.UtcNow - serverStartedAt).TotalSeconds;
            if (code == 0)
            {
                // clean exit: either another instance already owns the port (server opened it and left)
                // or the server was asked to shut down elsewhere — in both cases the tray has no job left
                if (uptime < 10) Balloon("MDSyncView 已在运行", "已打开正在运行的实例。", ToolTipIcon.Info);
                Quit();
                return;
            }
            if (restarts < MaxRestarts)
            {
                restarts++;
                Balloon("服务已停止，正在重启", "MDSyncView 服务异常退出（代码 " + code + "），第 " + restarts + " 次重启。", ToolTipIcon.Warning);
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = 2000;
                t.Tick += delegate { t.Stop(); t.Dispose(); if (!quitting) StartServer(); };
                t.Start();
            }
            else
            {
                Balloon("MDSyncView 服务无法启动", "已连续失败，请查看日志：" + logPath, ToolTipIcon.Error);
                StartShell(logPath);
                Quit();
            }
        }

        void RestartServer(string reason)
        {
            WriteLog("[tray] restart requested: " + reason);
            restarts = 0;
            StopServer(3000);
            if (!quitting) StartServer();
        }

        void StopServer(int waitMs)
        {
            if (server == null) return;
            try
            {
                if (!server.HasExited)
                {
                    PostToServer(port, "/api/shutdown");
                    if (!server.WaitForExit(waitMs))
                    {
                        WriteLog("[tray] server did not exit in time, killing");
                        server.Kill();
                        server.WaitForExit(2000);
                    }
                }
            }
            catch (Exception ex) { WriteLog("[tray] stop failed: " + ex.Message); }
        }

        void Tick()
        {
            if (quitting || uiOpened || server == null) return;
            if (server.HasExited) return;
            if ((DateTime.UtcNow - serverStartedAt).TotalSeconds > 60)
            {
                uiOpened = true; // stop probing; the balloon tells the user to check the log
                Balloon("MDSyncView 服务启动超时", "60 秒内没有响应，请查看日志：" + logPath, ToolTipIcon.Warning);
                return;
            }
            if (Health())
            {
                uiOpened = true;
                if (restarts == 0)
                    Balloon("MDSyncView 正在后台运行", "双击托盘图标打开界面。若图标未显示在任务栏，请在托盘溢出区（^）中查看，可拖到任务栏固定。", ToolTipIcon.Info);
                if (!noAutoUi) OpenUi();
            }
        }

        /** Picks the effective port out of the server's "listening on http://127.0.0.1:NNNN/" line. */
        void NoteListening(string line)
        {
            if (line == null) return;
            int i = line.IndexOf("listening on http://127.0.0.1:", StringComparison.Ordinal);
            if (i < 0) return;
            string rest = line.Substring(i + "listening on http://127.0.0.1:".Length);
            int end = rest.IndexOf('/');
            int p;
            if (end > 0 && int.TryParse(rest.Substring(0, end), out p) && p > 0 && p != port)
            {
                port = p;
                try { icon.Text = "MDSyncView · 127.0.0.1:" + port; } catch { }
                WriteLog("[tray] server is on port " + port);
            }
        }

        // ---- actions ----------------------------------------------------------------------------------

        void OpenUi()
        {
            if (!PostToServer(port, "/api/open-ui")) StartShell(Url("/"));
        }

        void Quit()
        {
            if (quitting) return;
            quitting = true;
            watchdog.Stop();
            icon.Visible = false;
            StopServer(3000);
            CloseLog();
            ExitThread();
        }

        // ---- helpers ----------------------------------------------------------------------------------

        string Url(string path) { return "http://127.0.0.1:" + port + path; }

        bool Health()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Url("/api/health"));
                req.Timeout = 1500;
                req.Proxy = null;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) { return (int)res.StatusCode == 200; }
            }
            catch { return false; }
        }

        public static bool PostToServer(int port, string path)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = "POST";
                req.Timeout = 3000;
                req.Proxy = null;
                req.ContentType = "application/json";
                req.Headers["X-MDSV"] = "1";
                byte[] body = Encoding.UTF8.GetBytes("{}");
                req.ContentLength = body.Length;
                using (Stream s = req.GetRequestStream()) { s.Write(body, 0, body.Length); }
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) { return (int)res.StatusCode < 300; }
            }
            catch { return false; }
        }

        void Balloon(string title, string text, ToolTipIcon kind)
        {
            try { icon.ShowBalloonTip(5000, title, text, kind); } catch { }
        }

        static void StartShell(string target)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(target);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        }

        static Icon LoadIcon()
        {
            try
            {
                Icon fromExe = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (fromExe != null) return fromExe;
            }
            catch { }
            return SystemIcons.Application;
        }

        public static int ParsePort(string[] args)
        {
            int p;
            string v = ArgValue(args, "port");
            return (!string.IsNullOrEmpty(v) && int.TryParse(v, out p) && p > 0) ? p : DefaultPort;
        }

        static string ArgValue(string[] args, string name)
        {
            string prefix = "--" + name + "=";
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i].StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return args[i].Substring(prefix.Length);
                if (string.Equals(args[i], "--" + name, StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) return args[i + 1];
            }
            return null;
        }

        static string JoinArgs(List<string> parts)
        {
            StringBuilder sb = new StringBuilder();
            foreach (string p in parts)
            {
                if (sb.Length > 0) sb.Append(' ');
                if (p.IndexOfAny(new char[] { ' ', '"', '\t' }) < 0) { sb.Append(p); continue; }
                sb.Append('"').Append(p.Replace("\\\"", "\\\\\"").Replace("\"", "\\\"")).Append('"');
            }
            return sb.ToString();
        }

        void OpenLog()
        {
            try
            {
                if (log != null) return;
                FileInfo fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > 5 * 1024 * 1024) fi.Delete();
                log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
                log.AutoFlush = true;
            }
            catch { log = null; }
        }

        void WriteLog(string line)
        {
            if (line == null) return;
            try { if (log != null) lock (log) { log.WriteLine(line); } } catch { }
        }

        void CloseLog()
        {
            try { if (log != null) { log.Dispose(); log = null; } } catch { }
        }
    }
}
