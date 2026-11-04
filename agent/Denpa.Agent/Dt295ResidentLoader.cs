/*
 * mAgicVISION (https://github.com/makeding/mAgicVISION、commit c937107) の core/loader.c (mb86H_loader_install・
 * native_install_hook・mb86H_loader_start・mb86H_loader_close) と core/recovery.c (mb86H_loader_adopt) のうち、
 * PIX-DT295 の部分を移したもの。Copyright (c) 2026 huggy、MIT License (全文は licenses/mAgicVISION.txt)。
 *
 * 元のコードは、導入の前に boot0 の body・常駐イメージの RAM などを写して、終わったら書き戻せる (mb86H_loader_restore)。
 * denpa は書き戻さない。閉じるときは常駐イメージを機材に残したまま手放し (mb86H_loader_close と同じ)、元のファームウェアに戻すときは
 * USB をつなぎ直す。そのため写しは取らず、写しにしか使わない読み出しも移していない。
 */

using static Denpa.Agent.Dt295ResidentProtocol;

namespace Denpa.Agent;

/// <summary>常駐イメージを機材に入れる・残っているものを引き継ぐ・手放す</summary>
public static class Dt295ResidentLoader
{
    /// <summary>boot0 の状態のレジスター (0 が冷えた状態)</summary>
    public const uint StateRegister = 0x82008;

    /// <summary>機材に入れたか、残っていたものを引き継いだか</summary>
    public enum Outcome
    {
        Installed,
        Adopted,
    }

    /// <summary>
    /// 常駐イメージを使える状態にする (mb86H_loader_start)。前のエージェントが残した同じイメージがあれば引き継ぎ (RECOVER)、
    /// 無ければ冷えた機材に入れる。そのあと様子を問い合わせて INITIALIZE する。
    /// 冷えた状態でも同じイメージでもなければ <see cref="Dt295ResidentColdException"/> を投げる (USB のつなぎ直しが要る)
    /// </summary>
    public static Outcome Start(IDt295ResidentTransport transport, Dt295ResidentSession session, Dt295ResidentImage image, Action<string>? log = null)
    {
        var outcome = Adopt(transport, session, image, log) ? Outcome.Adopted : Install(transport, session, image, log);
        session.QueryOverview();
        session.Initialize();
        return outcome;
    }

    /// <summary>
    /// 残っている常駐イメージを引き継ぐ (recovery.c の mb86H_loader_adopt)。hook が元の boot0 のままなら何もせず false。
    /// 導入したあとの値と、body・常駐イメージの書き換えない範囲・説明・ビルドの印が全部同じなら、RECOVER で前の持ち主の仕事を
    /// 片付けて true。どちらでもなければ <see cref="Dt295ResidentColdException"/>
    /// </summary>
    public static bool Adopt(IDt295ResidentTransport transport, Dt295ResidentSession session, Dt295ResidentImage image, Action<string>? log = null)
    {
        var hook = new byte[Dt295ResidentImage.HookBytes];
        transport.Read(Dt295ResidentImage.Hook, hook);
        if (hook.AsSpan().SequenceEqual(image.Original(Dt295ResidentImage.Hook, Dt295ResidentImage.HookBytes))) return false;
        if (!hook.AsSpan().SequenceEqual(image.Installed(Dt295ResidentImage.Hook, Dt295ResidentImage.HookBytes)))
        {
            throw new Dt295ResidentColdException($"boot0 の hook が、元の値とも常駐方式の値とも違います ({Convert.ToHexString(hook)})");
        }
        Exact(transport, image, Dt295ResidentImage.Body, Dt295ResidentImage.BodyBytes, "body");
        transport.BlockWrites = true;
        Ping(session);
        Anchor(session, image, Dt295ResidentImage.Commit, 4);
        Anchor(session, image, Dt295ResidentImage.Meta, 24);
        Anchor(session, image, Dt295ResidentImage.BuildId, 8);
        Resident(session, image);
        var reply = session.Command(CommandCapabilities, 0, new byte[DataSize]);
        if (Result(reply) != Ok || Word(reply, 16) != AbiVersion || !Identified(reply) || !reply.AsSpan(40, 8).SequenceEqual(image.Build)
            || reply[39] != RfMask)
        {
            throw new Dt295ResidentColdException("残っている常駐イメージが、同梱のものと違います");
        }
        log?.Invoke("残っていた常駐イメージを引き継ぎます");
        // 中身を確かめてから、状態を変える要求を送る。RECOVER は前の仕事を片付けるだけで、やり直しはしない
        var started = session.NowMs;
        while (true)
        {
            reply = session.Command(CommandRecover, 0, new byte[DataSize]);
            if (Result(reply) != Ok) throw new Dt295ResidentException($"前の持ち主の仕事を片付けられません (結果 {Result(reply)})");
            var state = session.QueryState(0);
            if (state.OwnerError < 0) throw new Dt295ResidentException($"常駐イメージが失敗を記録しています (理由 {state.OwnerError})", state.OwnerError);
            if (Dt295ResidentSession.Released(state)) return true;
            if (session.NowMs - started > SettleTimeoutMs) throw new TimeoutException($"前の持ち主の仕事が {SettleTimeoutMs} ms のうちに片付きませんでした");
            session.Delay(10);
        }
    }

    /// <summary>
    /// 冷えた機材に常駐イメージを入れる (loader.c の native_install_hook と mb86H_loader_install の DT295 の分)。
    /// 状態が 0 で、boot0 のコードが同梱の写しと同じことを確かめてから、body・hook を書いて照合し、PING・常駐イメージの書き込み・
    /// CAPABILITIES の順に進む
    /// </summary>
    public static Outcome Install(IDt295ResidentTransport transport, Dt295ResidentSession session, Dt295ResidentImage image, Action<string>? log = null)
    {
        var state = new byte[2];
        transport.Read(StateRegister, state);
        if (state[0] != 0 || state[1] != 0)
        {
            throw new Dt295ResidentColdException($"機材が冷えた状態ではありません (状態 0x{state[0]:X2}{state[1]:X2})");
        }
        // boot0 のコードが、同梱の写しのとおりか (ほかの版の boot0 には書かない)
        var expected = image.Original(Dt295ResidentImage.Code, Dt295ResidentImage.CodeBytes);
        if (expected.IsEmpty) throw new InvalidDataException("mAgicVISION のファームウェアに boot0 の写しがありません");
        Compare(transport, Dt295ResidentImage.Code, expected, "boot0 のコード");
        log?.Invoke("常駐イメージを入れます");
        transport.BlockWrites = true;
        var body = image.Installed(Dt295ResidentImage.Body, Dt295ResidentImage.BodyBytes);
        for (var offset = 0; offset < body.Length; offset += 64)
        {
            transport.Write(Dt295ResidentImage.Body + (uint)offset, body.AsSpan(offset, 64));
        }
        Compare(transport, Dt295ResidentImage.Body, body, "書いた body");
        var hook = image.Installed(Dt295ResidentImage.Hook, Dt295ResidentImage.HookBytes);
        transport.Write(Dt295ResidentImage.Hook, hook);
        Compare(transport, Dt295ResidentImage.Hook, hook, "書いた hook");
        Ping(session);
        session.Program(image.Resident);
        var reply = session.Command(CommandCapabilities, 0, new byte[DataSize]);
        if (Result(reply) != Ok || Word(reply, 16) != AbiVersion || !Identified(reply) || reply[DataOffset + 15] != RfMask)
        {
            throw new Dt295ResidentException($"入れた常駐イメージの応答が想定と違います (結果 {Result(reply)}、ABI {Word(reply, 16)})");
        }
        return Outcome.Installed;
    }

    /// <summary>
    /// 常駐イメージを機材に残したまま手放す (mb86H_loader_close。DT295 は SHUTDOWN のあと、同じイメージをもう一度初期化できる)。
    /// 次に開くときは <see cref="Adopt"/> で引き継ぐ
    /// </summary>
    public static void Close(Dt295ResidentSession session) => session.Shutdown(detach: true);

    private static bool Identified(byte[] reply) => System.Text.Encoding.ASCII.GetString(reply, DataOffset, Identity.Length) == Identity;

    private static void Ping(Dt295ResidentSession session)
    {
        var reply = session.Exchange(Dt295ResidentProtocol.Ping, 0, 0, 0, new byte[DataSize]);
        if (Result(reply) != Ok || Word(reply, 12) != 1) throw new Dt295ResidentException($"boot0 の PING の応答が想定と違います (結果 {Result(reply)})");
    }

    /// <summary>機材のメモリーを 64 バイトずつ読んで比べる (loader.c の read_region・verify_region)</summary>
    private static void Compare(IDt295ResidentTransport transport, uint address, ReadOnlySpan<byte> expected, string what)
    {
        Span<byte> got = stackalloc byte[64];
        for (var offset = 0; offset < expected.Length; offset += 64)
        {
            var length = Math.Min(64, expected.Length - offset);
            transport.Read(address + (uint)offset, got[..length]);
            if (!got[..length].SequenceEqual(expected.Slice(offset, length)))
            {
                throw new Dt295ResidentColdException($"{what} (0x{address + offset:X}) が想定と違います");
            }
        }
    }

    /// <summary>導入したあとの boot0 の値と同じか (recovery.c の exact_region)</summary>
    private static void Exact(IDt295ResidentTransport transport, Dt295ResidentImage image, uint address, int length, string what) =>
        Compare(transport, address, image.Installed(address, length), what);

    /// <summary>常駐イメージの小さな印を先に比べる (recovery.c の validate_resident_anchor)。違うイメージなら全部を読まずに断る</summary>
    private static void Anchor(Dt295ResidentSession session, Dt295ResidentImage image, uint address, int length)
    {
        Span<byte> got = stackalloc byte[24];
        var offset = address - Dt295ResidentImage.Base;
        session.ReadBlock(offset, got[..length]);
        if (!got[..length].SequenceEqual(image.Resident.Slice((int)offset, length)))
        {
            throw new Dt295ResidentColdException($"残っている常駐イメージの 0x{address:X8} が、同梱のものと違います");
        }
    }

    /// <summary>
    /// 残っている常駐イメージの、書き換えない範囲・説明・ビルドの印を全部比べる (recovery.c の validate_resident)。
    /// 動いている間に変わる範囲は比べない
    /// </summary>
    private static void Resident(Dt295ResidentSession session, Dt295ResidentImage image)
    {
        var resident = image.Resident;
        var immutable = (int)(Dt295ResidentImage.ImmutableEnd - Dt295ResidentImage.Base);
        var meta = (int)(Dt295ResidentImage.Meta - Dt295ResidentImage.Base);
        var build = (int)(Dt295ResidentImage.BuildId - Dt295ResidentImage.Base);
        Span<byte> got = stackalloc byte[Dt295ResidentSession.BlockBytes];
        for (var offset = 0; offset < Dt295ResidentImage.Bytes; offset += Dt295ResidentSession.BlockBytes)
        {
            var count = Math.Min(Dt295ResidentSession.BlockBytes, Dt295ResidentImage.Bytes - offset);
            if (offset >= immutable && offset + count <= meta) continue;
            session.ReadBlock((uint)offset, got[..count]);
            for (var i = 0; i < count; i++)
            {
                var position = offset + i;
                var compared = position < immutable || (position >= meta && position < meta + 24) || position >= build;
                if (compared && got[i] != resident[position])
                {
                    throw new Dt295ResidentColdException($"残っている常駐イメージの 0x{Dt295ResidentImage.Base + position:X8} が、同梱のものと違います");
                }
            }
        }
    }
}

/// <summary>機材が冷えた状態でも、同梱の常駐イメージが動いている状態でもない。USB をつなぎ直すと冷えた状態に戻る</summary>
public sealed class Dt295ResidentColdException(string message) : IOException(message);
