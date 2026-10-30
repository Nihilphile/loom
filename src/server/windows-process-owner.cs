using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Loom {
  public static class ProcessOwner {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
      public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT_INFORMATION {
      public BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
      public int cb;
      public string lpReserved, lpDesktop, lpTitle;
      public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2;
      public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
      public IntPtr hProcess, hThread;
      public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
      public STARTUPINFO StartupInfo;
      public IntPtr AttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint low, high; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FILETIME created, out FILETIME ended, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);

    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
      StringBuilder result = new StringBuilder("\"");
      int slashes = 0;
      foreach (char character in value) {
        if (character == '\\') { slashes++; continue; }
        if (character == '"') result.Append('\\', slashes * 2 + 1);
        else result.Append('\\', slashes);
        result.Append(character); slashes = 0;
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static string Identity(IntPtr handle, uint pid) {
      FILETIME created, ended, kernel, user;
      Check(GetProcessTimes(handle, out created, out ended, out kernel, out user));
      return pid.ToString() + ":" + (((ulong)created.high << 32) | created.low).ToString();
    }
    static List<uint> Members(IntPtr job) {
      for (int capacity = 1024; capacity <= 8 * 1024 * 1024; capacity *= 2) {
        IntPtr buffer = Marshal.AllocHGlobal(capacity);
        try {
          uint returned;
          if (!QueryInformationJobObject(job, 3, buffer, (uint)capacity, out returned)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 234) continue;
            throw new Win32Exception(error);
          }
          int count = Marshal.ReadInt32(buffer, 4);
          List<uint> ids = new List<uint>();
          for (int i = 0; i < count; i++) ids.Add((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
          return ids;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("Session process inventory exceeded limit");
    }
    static object[] List(IntPtr job, uint rootPid) {
      List<object> values = new List<object>();
      foreach (uint pid in Members(job)) {
        IntPtr handle = OpenProcess(0x100000 | 0x1000, false, pid);
        if (handle == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() == 87) continue;
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
          if (WaitForSingleObject(handle, 0) == 0) continue;
          bool owned; Check(IsProcessInJob(handle, job, out owned));
          if (!owned) continue;
          using (Process process = Process.GetProcessById((int)pid)) {
            string name = process.ProcessName;
            long memory = process.WorkingSet64;
            values.Add(new { id = Identity(handle, pid), pid, name, role = pid == rootPid ? "backend" : "descendant", memoryBytes = memory });
          }
        } catch (ArgumentException) { }
        catch (InvalidOperationException) { if (WaitForSingleObject(handle, 0) != 0) throw; }
        finally { CloseHandle(handle); }
      }
      return values.ToArray();
    }
    static void Stop(IntPtr job, string identity) {
      uint pid;
      if (identity == null || !uint.TryParse(identity.Split(':')[0], out pid)) throw new InvalidOperationException("Resource is not owned by this session");
      IntPtr handle = OpenProcess(0x100000 | 0x1000 | 1, false, pid);
      if (handle == IntPtr.Zero) throw new InvalidOperationException("Resource is no longer available");
      try {
        bool owned; Check(IsProcessInJob(handle, job, out owned));
        if (!owned || Identity(handle, pid) != identity) throw new InvalidOperationException("Resource is not owned by this session");
        Check(TerminateProcess(handle, 1));
        if (WaitForSingleObject(handle, 5000) != 0) throw new InvalidOperationException("Resource did not exit");
      } finally { CloseHandle(handle); }
    }
    static void Clean(IntPtr job) {
      Check(TerminateJobObject(job, 1));
      DateTime deadline = DateTime.UtcNow.AddSeconds(5);
      while (Members(job).Count > 0) {
        if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Session processes did not exit");
        Thread.Sleep(20);
      }
    }
    public static void Run(string pipeName) {
      IntPtr job = IntPtr.Zero;
      PROCESS_INFORMATION root = new PROCESS_INFORMATION();
      Task watch = null;
      using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous)) {
        pipe.Connect(15000);
        using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
        using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) {
          writer.AutoFlush = true;
          JavaScriptSerializer serializer = new JavaScriptSerializer();
          object writeLock = new object();
          Action<object> send = value => { lock (writeLock) writer.WriteLine(serializer.Serialize(value)); };
          try {
            Dictionary<string, object> config = serializer.Deserialize<Dictionary<string, object>>(reader.ReadLine());
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            EXTENDED_LIMIT_INFORMATION limits = new EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = 0x100 | 1;
            startup.StartupInfo.hStdInput = GetStdHandle(-10);
            startup.StartupInfo.hStdOutput = GetStdHandle(-11);
            startup.StartupInfo.hStdError = GetStdHandle(-12);
            Check(SetHandleInformation(startup.StartupInfo.hStdInput, 1, 1));
            Check(SetHandleInformation(startup.StartupInfo.hStdOutput, 1, 1));
            Check(SetHandleInformation(startup.StartupInfo.hStdError, 1, 1));
            string executable = (string)config["executable"];
            StringBuilder command = new StringBuilder(Quote(executable));
            foreach (object argument in (ArrayList)config["args"]) command.Append(' ').Append(Quote((string)argument));
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            startup.AttributeList = Marshal.AllocHGlobal(attributeSize);
            IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size);
            bool attributesInitialized = false;
            try {
              Check(InitializeProcThreadAttributeList(startup.AttributeList, 1, 0, ref attributeSize));
              attributesInitialized = true;
              Marshal.WriteIntPtr(jobList, job);
              Check(UpdateProcThreadAttribute(startup.AttributeList, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
              Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x08000000, IntPtr.Zero, (string)config["cwd"], ref startup, out root));
            } finally {
              if (attributesInitialized) DeleteProcThreadAttributeList(startup.AttributeList);
              Marshal.FreeHGlobal(startup.AttributeList);
              Marshal.FreeHGlobal(jobList);
            }
            CloseHandle(root.hThread); root.hThread = IntPtr.Zero;
            send(new { type = "ready", pid = root.dwProcessId });
            IntPtr processHandle = root.hProcess;
            watch = Task.Run(() => {
              WaitForSingleObject(processHandle, uint.MaxValue);
              uint code; GetExitCodeProcess(processHandle, out code);
              try { send(new { type = "exit", code }); } catch (IOException) { }
            });
            string line;
            while ((line = reader.ReadLine()) != null) {
              Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(line);
              object id = request["id"];
              string method = (string)request["method"];
              try {
                if (method == "list") send(new { id, result = List(job, root.dwProcessId) });
                else if (method == "stop") { Stop(job, (string)request["resourceId"]); send(new { id, result = true }); }
                else if (method == "close") { Clean(job); send(new { id, result = true }); break; }
                else throw new InvalidOperationException("Unknown process operation");
              } catch (Exception error) { send(new { id, error = error.Message }); }
            }
          } catch (Exception error) {
            try { send(new { type = "fault", error = error.Message }); } catch (IOException) { }
          } finally {
            if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); }
            if (watch != null) watch.Wait(5000);
            if (root.hThread != IntPtr.Zero) CloseHandle(root.hThread);
            if (root.hProcess != IntPtr.Zero) CloseHandle(root.hProcess);
          }
        }
      }
    }
  }
}
