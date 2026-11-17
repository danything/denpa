namespace Denpa.Agent.Tests;

/*
 * USB の機材の持ち主に共通の部分 (PortOwner.cs)。登録・使い回し・返す・抜けたときの扱いを、偽の持ち主で直に確かめる (CloseAll がほかのテストの持ち主も閉じるので、並べて走らせない)。
 * 機材ごとの開き方・返し方は Zd1jTests.cs と Dt295NativeTests.cs が確かめる
 */
[NotInParallel(nameof(PortOwnerTests))]
public class PortOwnerTests
{
    /// <summary>偽の持ち主。閉じた回数を持つ。取り方と返し方は Zd1jBoard と同じ形にする</summary>
    private sealed class FakeOwner : PortOwner<FakeOwner>
    {
        public int Closes { get; private set; }
        public bool Broken { get; set; }

        private protected override bool Dead => Broken;

        private protected override void Close() => Closes++;

        public static FakeOwner Acquire(string port)
        {
            lock (Registry)
            {
                if (TryReuse(port, out var owner)) return owner;
                owner?.Close();
                var opened = new FakeOwner { _users = 1 };
                Owners[port] = opened;
                return opened;
            }
        }

        public void Release()
        {
            lock (_gate)
            {
                if (--_users > 0) return;
            }
            if (Faulted) Close();
        }

        public static void CloseIfIdle(string port, bool closeInRegistry) => CloseIdle(port, closeInRegistry);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task 使っている間は同じ持ち主を使い回し_誰も使わなくなってから閉じる(bool closeInRegistry)
    {
        var port = closeInRegistry ? "po-1" : "po-2";
        var first = FakeOwner.Acquire(port);
        var second = FakeOwner.Acquire(port);
        await Assert.That(second).IsSameReferenceAs(first);

        // 1 つ返しても、まだ使っている側がいるので閉じない
        first.Release();
        FakeOwner.CloseIfIdle(port, closeInRegistry);
        await Assert.That(first.Closes).IsEqualTo(0);

        // 全部返すと閉じ、一覧から外れる。次に取る側は新しく開く
        second.Release();
        FakeOwner.CloseIfIdle(port, closeInRegistry);
        await Assert.That(first.Closes).IsEqualTo(1);
        var reopened = FakeOwner.Acquire(port);
        await Assert.That(reopened).IsNotSameReferenceAs(first);
        reopened.Release();
        FakeOwner.CloseIfIdle(port, closeInRegistry);
    }

    [Test]
    public async Task 抜けた印は_USB_の抜けだけで付く()
    {
        const string port = "po-3";
        var owner = FakeOwner.Acquire(port);
        owner.Fail(new IOException("時間切れ"));
        await Assert.That(owner.Faulted).IsFalse();
        owner.Fail(new UsbGoneException("抜かれました"));
        await Assert.That(owner.Faulted).IsTrue();

        // 使えなくなった持ち主は、最後の利用者が返したらすぐ閉じる
        owner.Release();
        await Assert.That(owner.Closes).IsEqualTo(1);
        FakeOwner.CloseIfIdle(port, closeInRegistry: true);
    }

    [Test]
    public async Task 使えなくなった持ち主は使い回さず_閉じて開き直す()
    {
        const string port = "po-4";
        var owner = FakeOwner.Acquire(port);
        // 機材ごとの印 (制御転送が通らない・ブリッジが応答しない) でも使えないものとする
        owner.Broken = true;
        await Assert.That(owner.Faulted).IsTrue();

        var next = FakeOwner.Acquire(port);
        await Assert.That(next).IsNotSameReferenceAs(owner);
        await Assert.That(owner.Closes).IsEqualTo(1);
        await Assert.That(next.Faulted).IsFalse();
        next.Release();
        FakeOwner.CloseIfIdle(port, closeInRegistry: true);
    }

    [Test]
    public async Task CloseAll_は使っている側がいても全部閉じる()
    {
        var a = FakeOwner.Acquire("po-5");
        var b = FakeOwner.Acquire("po-6");
        FakeOwner.CloseAll();
        await Assert.That(a.Closes).IsEqualTo(1);
        await Assert.That(b.Closes).IsEqualTo(1);
        var again = FakeOwner.Acquire("po-5");
        await Assert.That(again).IsNotSameReferenceAs(a);
        again.Release();
        FakeOwner.CloseIfIdle("po-5", closeInRegistry: true);
    }
}
