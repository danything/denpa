using System.Runtime.CompilerServices;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * USB の層 (UsbDevice.cs・UsbFsDevice.cs)。機材なしで確かめられる所: usbfs の ioctl の番号と構造体の大きさ
 * (カーネルの uapi の linux/usbdevice_fs.h の形)、Windows と macOS のポートの名前の作り方。
 */
public class UsbDeviceTests
{
    [Test]
    public async Task usbfs_の構造体と_ioctl_の番号()
    {
        // 64bit (x64・arm64) の大きさ
        await Assert.That(Unsafe.SizeOf<UsbFsDevice.ControlTransfer>()).IsEqualTo(24);
        await Assert.That(Unsafe.SizeOf<UsbFsDevice.SetInterfaceRequest>()).IsEqualTo(8);
        await Assert.That(Unsafe.SizeOf<UsbFsDevice.Urb>()).IsEqualTo(56);
        // _IOWR('U', 0, struct usbdevfs_ctrltransfer) など
        await Assert.That(UsbFsDevice.Control).IsEqualTo(0xC0185500u);
        await Assert.That(UsbFsDevice.SetInterface).IsEqualTo(0x80085504u);
        await Assert.That(UsbFsDevice.SubmitUrb).IsEqualTo(0x8038550Au);
        await Assert.That(UsbFsDevice.DiscardUrb).IsEqualTo(0x0000550Bu);
        await Assert.That(UsbFsDevice.ReapUrbNoDelay).IsEqualTo(0x4008550Du);
        await Assert.That(UsbFsDevice.ClearHalt).IsEqualTo(0x80045515u);
    }

    [Test]
    public async Task Windows_のポートの名前は場所の文字列から()
    {
        string[] controllers = ["PCIROOT(0)#PCI(0800)#PCI(0003)", "PCIROOT(0)#PCI(1400)"];
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)#USB(2)", controllers)).IsEqualTo("2-3.2");
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(0800)#PCI(0003)#USBROOT(0)#USB(11)", controllers)).IsEqualTo("1-11");
        // コントローラーが分からない・ポートが無い
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(1D00)#USBROOT(0)#USB(1)", controllers)).IsNull();
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(1400)#USBROOT(0)", controllers)).IsNull();
        await Assert.That(UsbDevices.WindowsPort("ACPI(_SB_)", controllers)).IsNull();
    }

    [Test]
    public async Task macOS_のポートの名前は_locationID_から()
    {
        await Assert.That(UsbDevices.MacPort(0x14320000)).IsEqualTo("20-3.2");
        await Assert.That(UsbDevices.MacPort(0x01100000)).IsEqualTo("1-1");
        await Assert.That(UsbDevices.MacPort(0x14000000)).IsNull();
        // どれも sysfs の名前と同じ形なので、zd1j: の device にそのまま書ける
        await Assert.That(Zd1j.Parse($"zd1j:{UsbDevices.MacPort(0x14320000)}")).IsEqualTo("20-3.2");
    }
}
