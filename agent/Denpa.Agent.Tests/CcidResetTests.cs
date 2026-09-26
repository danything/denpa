using Denpa.Agent;

namespace Denpa.Agent.Tests;

/// <summary>
/// **固まったリーダーは、USB のポートをリセットして1回だけ立て直す。**
/// 前のエージェントがやり取りの最中に止められると、リーダーは USB からは繋がって見えるのに
/// 何を送っても応えなくなる (実機で起きた)。人が unbind / bind していたのを自分でやる
/// </summary>
public class CcidResetTests
{
    private static readonly byte[] Atr = Convert.FromHexString("3BF01200FF9181B17C451F0399");

    /// <summary>APDU 単位で、電圧も速さも自分で決めるリーダー (T=1 の枠組みも SetParameters も要らない)</summary>
    private static readonly CcidInterface Plain = new(
        0, 0x82, 0x02, 64,
        CcidInterface.ExtendedApduLevel | CcidInterface.AutoParameters | CcidInterface.AutoVoltage,
        271, 254, 0x07, 0x03, 4000);

    /// <summary>リセットされるまで黙り (読むと時間切れ)、リセットされたら普通に答える</summary>
    private sealed class Frozen : IBulkPipe
    {
        private readonly Queue<byte[]> _replies = new();
        public bool Stuck { get; set; } = true;
        public int Resets { get; private set; }

        public void Write(ReadOnlySpan<byte> data)
        {
            if (Stuck) return;
            var command = CcidMessage.Parse(data);
            _replies.Enqueue(command.Type == CcidMessage.PowerOn
                ? CcidMessage.Command(CcidMessage.DataBlock, command.Seq, Atr)
                : CcidMessage.Command(CcidMessage.SlotStatus, command.Seq, [], 0x01));
        }

        public int Read(Span<byte> buffer, int timeoutMs)
        {
            if (Stuck || !_replies.TryDequeue(out var reply)) throw new IOException("リーダーが応答しません");
            reply.CopyTo(buffer);
            return reply.Length;
        }

        public void ResetPort()
        {
            Resets++;
            Stuck = false;
        }

        public void Dispose() { }
    }

    [Test]
    public async Task 黙ったリーダーはポートをリセットしてやり直す()
    {
        var pipe = new Frozen();
        var link = new CcidLink("PC Twin", pipe, Plain);

        await Assert.That(Convert.ToHexString(link.Reset())).IsEqualTo(Convert.ToHexString(Atr));
        await Assert.That(pipe.Resets).IsEqualTo(1);
    }

    [Test]
    public async Task リセットしても黙るなら投げる()
    {
        var pipe = new StillFrozen();
        var link = new CcidLink("PC Twin", pipe, Plain);

        await Assert.That(Assert.Throws<IOException>(() => link.Reset()).Message).Contains("応答しません");
        await Assert.That(pipe.Resets).IsEqualTo(1);
    }

    private sealed class StillFrozen : IBulkPipe
    {
        public int Resets { get; private set; }
        public void Write(ReadOnlySpan<byte> data) { }
        public int Read(Span<byte> buffer, int timeoutMs) => throw new IOException("リーダーが応答しません");
        public void ResetPort() => Resets++;
        public void Dispose() { }
    }
}
