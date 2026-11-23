// SPDX-License-Identifier: GPL-2.0-only
//
// denpa_asicen.h の実装。asicen-userland v1.0.0-beta の部品を、上流のデーモン (asicend) と同じ組み方でつなぐ。
//
// - 起動の手順 (引数・ファームウェアの流し込みと再列挙の待ち・筐体の組み合わせの確認・claim) は、上流の
//   userland/tools/asicend_hardware.cpp をファイルごと読み込み (変えずに)、その中の関数を使う。流れ (run_asicend_hardware) は
//   下の open_hardware に写して、最後のソケットの待ち受けの代わりに claim した機材を返すように直した。
//   直した所: Windows の分岐を落とした・識別のロック (acquire_identity_lease) を写さない (同じ筐体を別のソフトが使っていれば
//   claim が断る)・終了コードの代わりに Error を返す・メッセージを呼んだ側のバッファに書く・シグナルのハンドラを入れない
// - エンジンは上流のデーモン (run_core_server と AsicenEnclosureFamily) と同じ組み方:
//   LibusbW3u3Hardware → (shutdown を後に回す前段) → HardwareStreamService → TunerService (+ configure_strict_capabilities)。
//   選局はデーモンと同じ Hz の入口。ストリームはエンジンの従来の入口 (start_stream・attach_stream) を使う
//   (v1 の契約はソケットの相手と期限を取り決めるためのもので、同じプロセスでは要らない)
// - 上流のバージョンを上げるときは、写した流れを上流の run_asicend_hardware と比べ直す

#include "denpa_asicen.h"

// 上流のファイルの中だけの関数 (resolve_device・observed_identity・load_loader_firmware など) を使うために、ファイルごと読み込む
#include "asicend_hardware.cpp"

#include "asicend_discovery_json.h"
#include "asicen/hardware_stream_session.h"
#include "px4/posix_tuner_nonce.h"

#include <atomic>
#include <cstdarg>
#include <cstring>
#include <mutex>

#ifdef DENPA_ASICEN_MOCK
#include "asicen/px4_mock_backend.h"
#endif

namespace denpa_asicen {
namespace {

using px4::userland::Error;
using px4::userland::Result;
using px4::userland::ipc::System;

int code(Error error) noexcept { return static_cast<int>(error); }

// 呼んだ側のバッファにメッセージを書く (足りなければ切る)
class Message final {
public:
    Message(char* output, std::size_t capacity) noexcept : output_(output), capacity_(capacity)
    {
        if (output_ != nullptr && capacity_ > 0U) output_[0] = '\0';
    }
    __attribute__((format(printf, 2, 3))) void write(const char* format, ...) noexcept
    {
        if (output_ == nullptr || capacity_ == 0U) return;
        va_list arguments;
        va_start(arguments, format);
        (void)std::vsnprintf(output_, capacity_, format, arguments);
        va_end(arguments);
    }

private:
    char* output_;
    std::size_t capacity_;
};

// load_loader_firmware が返す終了コードを Error に戻す (asicen::cli::exit_status の逆。分類が粗いものは代表の値)
Error from_exit(int status) noexcept
{
    switch (status) {
    case 0: return Error::OK;
    case 2: return Error::INVALID_ARGUMENT;
    case 3: return Error::NOT_READY;
    case 4: return Error::BUSY;
    case 5: return Error::TIMEOUT;
    case 6: return Error::PROTOCOL_ERROR;
    case 7: return Error::USB_IO;
    case 10: return Error::FIRMWARE_REJECTED;
    default: return Error::INTERNAL;
    }
}

class SteadyTime final : public px4::userland::TunerServiceTime {
public:
    std::uint64_t monotonic_ms() noexcept override
    {
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
    }
    void sleep_ms(std::uint32_t milliseconds) noexcept override
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }
};

// 上流の DeferredHardwareShutdown (card_only_service.cpp。ファイルの中だけのもの) と同じ: HardwareStreamService の前段で、
// 機材の shutdown だけを後に回す (機材の後片付けは筐体を閉じるときに 1 度だけ)。ほかは素通し
class DeferredShutdown final : public px4::userland::TunerServiceBackend {
public:
    explicit DeferredShutdown(px4::userland::TunerServiceBackend& backend) noexcept : backend_(backend) {}
    std::uint8_t receiver_count() const noexcept override { return backend_.receiver_count(); }
    bool receiver_supports(std::uint8_t receiver, System system) const noexcept override
    {
        return backend_.receiver_supports(receiver, system);
    }
    bool selects_satellite_stream_before_tune() const noexcept override
    {
        return backend_.selects_satellite_stream_before_tune();
    }
    bool requires_terrestrial_lock_settle() const noexcept override
    {
        return backend_.requires_terrestrial_lock_settle();
    }
    Result<void> open_receiver(std::uint8_t receiver) noexcept override
    {
        return backend_.open_receiver(receiver);
    }
    Result<void> tune_terrestrial(std::uint8_t receiver, std::uint32_t frequency,
                                  std::uint32_t timeout) noexcept override
    {
        return backend_.tune_terrestrial(receiver, frequency, timeout);
    }
    Result<void> tune_satellite(std::uint8_t receiver, std::uint32_t frequency,
                                std::uint32_t timeout) noexcept override
    {
        return backend_.tune_satellite(receiver, frequency, timeout);
    }
    Result<bool> is_locked(std::uint8_t receiver, System system) noexcept override
    {
        return backend_.is_locked(receiver, system);
    }
    Result<void> select_satellite_slot(std::uint8_t receiver, std::uint8_t slot,
                                       std::uint32_t timeout) noexcept override
    {
        return backend_.select_satellite_slot(receiver, slot, timeout);
    }
    Result<void> select_satellite_tsid(std::uint8_t receiver, std::uint16_t tsid,
                                       std::uint32_t timeout) noexcept override
    {
        return backend_.select_satellite_tsid(receiver, tsid, timeout);
    }
    Result<void> close_receiver(std::uint8_t receiver) noexcept override
    {
        return backend_.close_receiver(receiver);
    }
    Result<void> begin_tune_power(std::uint8_t receiver, System system, std::uint8_t voltage) noexcept override
    {
        return backend_.begin_tune_power(receiver, system, voltage);
    }
    Result<void> commit_tune_power(std::uint8_t receiver) noexcept override
    {
        return backend_.commit_tune_power(receiver);
    }
    Result<void> rollback_tune_power(std::uint8_t receiver) noexcept override
    {
        return backend_.rollback_tune_power(receiver);
    }
    Result<void> set_independent_lnb_power(bool enabled) noexcept override
    {
        return backend_.set_independent_lnb_power(enabled);
    }
    dtv::userland::wire::Optional<bool> independent_lnb_power_state() noexcept override
    {
        return backend_.independent_lnb_power_state();
    }
    void mark_receiver_disconnected(std::uint8_t receiver) noexcept override
    {
        backend_.mark_receiver_disconnected(receiver);
    }
    void request_stop() noexcept override { backend_.request_stop(); }
    Result<void> shutdown() noexcept override { return Result<void>::success(); }

private:
    px4::userland::TunerServiceBackend& backend_;
};

#ifdef DENPA_ASICEN_MOCK
// 偽の取り込み (テスト用の組み方だけ)。CC を進めた null パケットを 10 ms ごとに 64 個出す
class MockCapture final : public asicen::StreamCaptureSource {
public:
    Result<void> prepare(std::uint8_t, System, const std::atomic<bool>&) noexcept override
    {
        return Result<void>::success();
    }
    asicen::CaptureRunResult run(const std::atomic<bool>& cancelled,
                                 bool (*emit)(void*, const std::uint8_t*, std::size_t),
                                 void* context) noexcept override
    {
        std::array<std::uint8_t, 64U * 188U> packets{};
        std::uint8_t counter = 0U;
        while (!cancelled.load()) {
            for (std::size_t packet = 0U; packet < 64U; ++packet) {
                std::uint8_t* bytes = packets.data() + packet * 188U;
                std::memset(bytes, 0xff, 188U);
                bytes[0] = 0x47U;
                bytes[1] = 0x1fU;
                bytes[2] = 0xffU;
                bytes[3] = static_cast<std::uint8_t>(0x10U | (counter++ & 0x0fU));
            }
            if (!emit(context, packets.data(), packets.size())) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return asicen::CaptureRunResult::cancelled;
    }
    void interrupt() noexcept override {}
    Result<void> stop() noexcept override { return Result<void>::success(); }
};
#endif

// 開いた筐体の中身。ストリームが参照するので、閉じたあとも残ったストリームが止まるまで消えない
struct Core final {
    // 本物の機材 (偽の機材では空)。context は hardware より長く生かす
    std::unique_ptr<asicen::LibusbContext> context;
    std::unique_ptr<asicen::LibusbW3u3Hardware> hardware;
#ifdef DENPA_ASICEN_MOCK
    std::unique_ptr<asicen::MockTunerBackend> mock;
    std::unique_ptr<MockCapture> capture;
#endif
    std::unique_ptr<DeferredShutdown> frontend;
    std::unique_ptr<asicen::HardwareStreamService> stream;
    px4::userland::ipc::posix::PosixTunerNonceSource nonce;
    SteadyTime time;
    std::unique_ptr<px4::userland::TunerService> tuner;
    std::string model;
    bool lnb = false;
    // クライアントの番号。ストリームごとに 1 つ (失敗した選局の後片付けがほかの受信機に響かない)
    std::atomic<std::uint64_t> next_client{1U};

    ~Core() noexcept
    {
        // エンジンが残った受信機を返し、HardwareStreamService の取り込みを止める。機材の後片付けはそのあと (上流のデーモンと同じ順)
        if (tuner) (void)tuner->shutdown();
        tuner.reset();
        stream.reset();
        frontend.reset();
        if (hardware) {
            const auto cleaned = hardware->shutdown();
            if (!cleaned)
                std::fprintf(stderr, "asicen: shutdown cleanup: %s\n", px4::userland::error_string(cleaned.error()));
            const auto released = hardware->release();
            if (!released)
                std::fprintf(stderr, "asicen: USB claim release: %s\n", px4::userland::error_string(released.error()));
        }
        hardware.reset();
        context.reset();
    }

    // エンジンを組む (backend は機材か偽の機材)
    Error assemble(px4::userland::TunerServiceBackend& backend, asicen::StreamCaptureSource& source) noexcept
    {
        frontend.reset(new (std::nothrow) DeferredShutdown(backend));
        if (!frontend) return Error::RESOURCE_LIMIT;
        stream.reset(new (std::nothrow) asicen::HardwareStreamService(*frontend, source));
        if (!stream) return Error::RESOURCE_LIMIT;
        tuner.reset(new (std::nothrow) px4::userland::TunerService(*stream, nonce, time, nullptr, nullptr, stream.get()));
        if (!tuner) return Error::RESOURCE_LIMIT;
        const auto strict = tuner->configure_strict_capabilities();
        return strict ? Error::OK : strict.error();
    }
};

// 上流の run_asicend_hardware を写して直したもの (この層の冒頭のコメント)。claim まで済ませた機材を out に置く。
// 流し込んだだけで開いていないときは DENPA_ASICEN_LOADED
int open_hardware(Options& options, Core& out, Message& message)
{
    auto fail = [&message](Error error, const char* what) {
        message.write("%s: %s", what, px4::userland::error_string(error));
        return code(error);
    };

    auto firmware = Result<asicen::FirmwareImage>::failure(Error::NOT_READY);
    if (!options.firmware.empty()) {
        firmware = asicen::FirmwareProvider(options.firmware).load();
        if (!firmware) return fail(firmware.error(), "firmware");
    }
    std::unique_ptr<asicen::LibusbContext> owned_context(new (std::nothrow) asicen::LibusbContext());
    if (!owned_context) return code(Error::RESOURCE_LIMIT);
    const int initialized = owned_context->initialize(options.file_descriptor_count != 0U);
    if (initialized != 0) {
        message.write("libusb_init: %s", libusb_error_name(initialized));
        return code(asicen::map_libusb_error(initialized));
    }
    libusb_context* context = owned_context->get();
    if (!options.device_selector.empty()) {
        const auto selected = resolve_device_selector(context, &options);
        if (selected != Error::OK) return fail(selected, "device selector");
    }
    if (options.file_descriptor_count != 0U) {
        const auto inferred = infer_file_descriptor_model(context, &options);
        if (inferred != Error::OK) return fail(inferred, "file descriptor model");
        if (options.expected_model == nullptr &&
            options.file_descriptor_count == 2U && !options.firmware.empty()) {
            message.write("firmware: loader FDs without a runtime model must be provisioned one at a time");
            return code(Error::NOT_READY);
        }
    }
    if (options.file_descriptor_count == 2U && options.expected_model != nullptr &&
        options.expected_model->expected_runtime_functions == 2U) {
        const auto first_identity = observed_identity(context, options, 0U);
        const auto second_identity = observed_identity(context, options, 1U);
        const auto first_path = observed_port_path(context, options, 0U);
        const auto second_path = observed_port_path(context, options, 1U);
        if (!first_identity || !second_identity || first_identity.value().empty() ||
            first_identity.value() != second_identity.value() || !first_path || !second_path ||
            first_path.value().size() < 2U || first_path.value().size() != second_path.value().size()) {
            message.write("refusing selected FDs without one observable sibling topology");
            return code(Error::INVALID_ARGUMENT);
        }
        const auto& a = first_path.value();
        const auto& b = second_path.value();
        if (!std::equal(a.begin(), a.end() - 1, b.begin()) ||
            !((a.back() == 1U && b.back() == 2U) || (a.back() == 2U && b.back() == 1U))) {
            message.write("refusing selected FDs outside the same ordered sibling paths");
            return code(Error::INVALID_ARGUMENT);
        }
        if (a.back() == 2U) std::swap(options.file_descriptors[0], options.file_descriptors[1]);
    }
    auto identity = observed_identity(context, options);
    if (!identity) return fail(identity.error(), "enclosure identity");
    if (identity.value().empty()) {
        const bool pathless_single_runtime = options.expected_model != nullptr &&
            options.file_descriptor_count == 1U &&
            options.expected_model->expected_runtime_functions == 1U &&
            options.firmware.empty();
        const bool selected_loader_for_transfer = options.expected_model != nullptr &&
            options.file_descriptor_count != 0U && !options.firmware.empty() &&
            options.file_descriptor_count <= options.expected_model->expected_runtime_functions;
        if (!pathless_single_runtime &&
            (options.expected_model == nullptr || options.file_descriptor_count == 0U ||
             !selected_loader_for_transfer)) {
            message.write("enclosure identity: runtime topology unavailable; loader transfer requires selected model functions");
            return code(Error::NOT_READY);
        }
        if (!pathless_single_runtime) {
            if (options.expected_model->expected_runtime_functions == 2U &&
                options.file_descriptor_count == 2U) {
                message.write("firmware: paired loader FDs require observable sibling topology");
                return code(Error::NOT_READY);
            }
            std::array<std::uint8_t, 2U> buses{};
            std::array<std::uint8_t, 2U> addresses{};
            for (std::size_t index = 0U; index < options.file_descriptor_count; ++index) {
                asicen::LibusbDevice device;
                const int opened = device.open(context, options.file_descriptors[index]);
                if (opened != 0)
                    return fail(asicen::map_libusb_acquisition_error(opened), "firmware: cannot open selected loader FD");
                libusb_device_descriptor descriptor{};
                const int described = device.descriptor(&descriptor);
                if (described != 0) {
                    message.write("firmware: descriptor read failed: %s", libusb_error_name(described));
                    return code(asicen::map_libusb_error(described));
                }
                const bool loader = descriptor.idVendor == 0x1738U &&
                    (descriptor.idProduct == 0x5211U || descriptor.idProduct == 0x5216U);
                if (!loader) {
                    message.write("firmware: selected pathless FD is not an ASICEN loader");
                    return code(Error::UNSUPPORTED);
                }
                buses[index] = static_cast<std::uint8_t>(libusb_get_bus_number(device.device()));
                addresses[index] = static_cast<std::uint8_t>(libusb_get_device_address(device.device()));
                for (std::size_t previous = 0U; previous < index; ++previous) {
                    if (buses[previous] == buses[index] && addresses[previous] == addresses[index]) {
                        message.write("firmware: selected FDs refer to the same USB function");
                        return code(Error::INVALID_ARGUMENT);
                    }
                }
                libusb_config_descriptor* config = nullptr;
                const int configured = libusb_get_config_descriptor(device.device(), 0U, &config);
                if (configured != 0 || config == nullptr) {
                    if (config != nullptr) libusb_free_config_descriptor(config);
                    message.write("firmware: loader configuration read failed: %s", libusb_error_name(configured));
                    return code(configured == 0 ? Error::UNSUPPORTED : asicen::map_libusb_error(configured));
                }
                const bool interface0 = config->bNumInterfaces == 1U &&
                    config->interface[0].num_altsetting == 1 &&
                    config->interface[0].altsetting[0].bInterfaceNumber == 0U &&
                    config->interface[0].altsetting[0].bAlternateSetting == 0U;
                libusb_free_config_descriptor(config);
                if (!interface0) {
                    message.write("firmware: loader interface profile mismatch");
                    return code(Error::UNSUPPORTED);
                }
            }
            const int transferred = load_loader_firmware(*owned_context, options, firmware.value(), nullptr, nullptr);
            if (transferred != 0) {
                message.write("firmware: loader transfer failed (asicend exit %d; details on stderr)", transferred);
                return code(from_exit(transferred));
            }
            message.write("firmware: loader transfer complete; grant the runtime USB function(s) and open again");
            return DENPA_ASICEN_LOADED;
        }
    }
    if (options.file_descriptor_count == 1U && options.expected_model != nullptr &&
        options.expected_model->expected_runtime_functions == 2U && options.firmware.empty()) {
        // 上流の「sibling restore」(片方だけファームウェア待ちに戻す手順)。denpa は --firmware を必ず渡すので通らない
        message.write("sibling restore is not supported here; pass --firmware");
        return code(Error::INVALID_ARGUMENT);
    }
    const std::size_t selected_count = options.file_descriptor_count != 0U
        ? options.file_descriptor_count : options.usb_path_count;
    std::vector<std::vector<std::uint8_t>> selected_fd_paths;
    for (std::size_t index = 0U; index < selected_count; ++index) {
        const auto selected = observed_identity(context, options, index);
        if (!selected) {
            asicen::UsbFunctionObservation pending;
            if (index == 0U || options.firmware.empty() ||
                options.file_descriptor_count != 0U ||
                (options.expected_model == nullptr && options.usb_path_count != 2U) ||
                (selected.error() != Error::NOT_FOUND && selected.error() != Error::NOT_READY) ||
                !parse_bus_port(options.usb_paths[index], &pending.bus, &pending.port_path) ||
                asicen::cli::topology_identity(pending,
                    options.expected_model != nullptr
                        ? options.expected_model->expected_runtime_functions == 2U
                        : options.usb_path_count == 2U) != identity.value()) {
                return fail(selected.error(), "enclosure identity");
            }
        } else if (selected.value().empty() && options.file_descriptor_count == 1U &&
                   options.expected_model != nullptr &&
                   options.expected_model->expected_runtime_functions == 1U &&
                   options.firmware.empty()) {
            // 上流と同じ: 渡された fd 1 つの機材をそのまま使う
        } else if (selected.value() != identity.value()) {
            message.write("refusing functions from different enclosures");
            return code(Error::INVALID_ARGUMENT);
        }
        if (options.file_descriptor_count != 0U) {
            const auto path = observed_port_path(context, options, index);
            const bool paired = options.expected_model != nullptr &&
                options.expected_model->expected_runtime_functions == 2U;
            const bool single_loader_target = paired && selected_count == 1U && !options.firmware.empty();
            const bool canonical_paired_path = !paired || (path && path.value().size() >= 2U &&
                (single_loader_target
                    ? (path.value().back() == 1U || path.value().back() == 2U)
                    : path.value().back() == (index == 0U ? 1U : 2U)));
            if ((!path || path.value().empty()) && paired) {
                message.write("refusing unknown or noncanonical USB function path");
                return path ? code(Error::INVALID_ARGUMENT) : code(path.error());
            }
            if (path && !path.value().empty() && !canonical_paired_path) {
                message.write("refusing unknown or noncanonical USB function path");
                return code(Error::INVALID_ARGUMENT);
            }
            if (path && !path.value().empty() && !selected_fd_paths.empty()) {
                const auto& primary_path = selected_fd_paths.front();
                const auto& sibling_path = path.value();
                if (primary_path.size() != sibling_path.size() ||
                    !std::equal(primary_path.begin(), primary_path.end() - 1, sibling_path.begin()) ||
                    primary_path.back() != 1U || sibling_path.back() != 2U) {
                    message.write("refusing functions outside the ordered sibling USB paths");
                    return code(Error::INVALID_ARGUMENT);
                }
            }
            if (path && !path.value().empty()) selected_fd_paths.push_back(path.value());
        }
        if (options.usb_path_count != 0U) {
            const auto resolved = resolve_device(context, options.usb_paths[index]);
            if (resolved) {
                asicen::UsbFunctionObservation observation;
                observation.bus = resolved.value().location.bus;
                observation.port_path = resolved.value().port_path;
                options.usb_paths[index] = asicen::cli::port_string(observation);
            }
            std::uint8_t bus = 0U;
            std::vector<std::uint8_t> ports;
            if (!parse_bus_port(options.usb_paths[index], &bus, &ports) ||
                (selected_count == 2U && ports.back() != index + 1U)) {
                message.write("refusing noncanonical primary/sibling port assignment");
                return code(Error::INVALID_ARGUMENT);
            }
        }
    }
    bool sibling_firmware_uploaded = false;
    if (!options.firmware.empty()) {
        LoaderIdentity loader_identity;
        std::vector<asicen::UploadedRuntimeIdentity> uploaded_identities;
        const int loaded = load_loader_firmware(*owned_context, options, firmware.value(),
                                                &loader_identity, &uploaded_identities);
        context = owned_context->get();
        if (loaded == kLoadFirmwareWarm) {
            // 動いている機材 (ファームウェアは入っている)。流し込まずに開く
        } else if (loaded != 0) {
            message.write("firmware: loader transfer failed (asicend exit %d; details on stderr)", loaded);
            return code(from_exit(loaded));
        } else if (options.file_descriptor_count != 0U) {
            message.write("firmware: --fd cannot follow the loader re-enumeration; grant the runtime fd and open again");
            return DENPA_ASICEN_LOADED;
        } else {
            if (options.expected_model != nullptr &&
                options.expected_model->expected_runtime_functions != selected_count) {
                message.write("device selector: selected function count does not match runtime model");
                return code(Error::INVALID_ARGUMENT);
            }
            sibling_firmware_uploaded = std::any_of(
                uploaded_identities.begin(), uploaded_identities.end(),
                [](const asicen::UploadedRuntimeIdentity& uploaded) { return uploaded.selected_index == 1U; });
            const auto readiness = asicen::wait_for_uploaded_runtimes(
                uploaded_identities,
                [context, model = options.expected_model](const asicen::UploadedRuntimeIdentity& uploaded) {
                    return probe_uploaded_runtime(context, model, uploaded);
                },
                [] { return std::chrono::steady_clock::now(); },
                [](std::chrono::milliseconds interval) {
                    sleep_ms(static_cast<std::uint32_t>(interval.count()));
                },
                [] { return px4::userland::px4d::stop_requested(); });
            if (readiness != Error::OK) return fail(readiness, "firmware: runtime did not re-enumerate");
        }
    }
    std::unique_ptr<asicen::LibusbW3u3Hardware> hardware;
    if (options.file_descriptor_count != 0U) {
        hardware.reset(new (std::nothrow) asicen::LibusbW3u3Hardware(
            context, options.file_descriptors[0],
            options.file_descriptor_count >= 2U ? options.file_descriptors[1] : -1,
            options.expected_model));
    } else {
        const auto primary = resolve_device(context, options.usb_paths[0]);
        if (!primary) return fail(primary.error(), "usb-path");
        asicen::UsbLocation primary_location = primary.value().location;
        std::vector<std::uint8_t> primary_path = primary.value().port_path;
        asicen::UsbLocation sibling_location{};
        std::vector<std::uint8_t> sibling_path;
        if (options.usb_path_count >= 2U) {
            const auto sibling = resolve_device(context, options.usb_paths[1]);
            if (!sibling) return fail(sibling.error(), "usb-path");
            sibling_location = sibling.value().location;
            sibling_path = sibling.value().port_path;
            if (primary_location.bus != sibling_location.bus || primary_path.empty() ||
                sibling_path.empty() || primary_path == sibling_path ||
                primary_path.back() != 1U || sibling_path.back() != 2U) {
                message.write("refusing noncanonical primary/sibling port assignment");
                return code(Error::INVALID_ARGUMENT);
            }
        }
        hardware.reset(new (std::nothrow) asicen::LibusbW3u3Hardware(
            context, primary_location, sibling_location,
            std::move(primary_path), std::move(sibling_path), options.expected_model,
            sibling_firmware_uploaded));
    }
    if (!hardware) return code(Error::RESOURCE_LIMIT);
    hardware->set_allow_lnb_power(options.allow_lnb_power);
    const auto claimed = hardware->claim();
    if (!claimed) {
        message.write("hardware model/topology/claim refused (dual-function models require sibling paths): %s",
                      px4::userland::error_string(claimed.error()));
        return code(claimed.error());
    }
    // ここから先で失敗したら、Core を壊すときに shutdown と release をする (上流のデーモンと同じ後片付け)
    out.context = std::move(owned_context);
    out.hardware = std::move(hardware);
    const auto* profile = out.hardware->device_profile();
    if (profile == nullptr || !asicen::profile_runtime_supported(*profile)) {
        message.write("hardware model is not runtime supported");
        return code(Error::UNSUPPORTED);
    }
    // 上流の run_core_server と同じく、取り込みのエンジンを組む前に機能を整える
    const auto prepared = out.hardware->prepare_runtime_functions();
    if (!prepared) return fail(prepared.error(), "prepare runtime functions");
    out.model = profile->model;
    out.lnb = out.hardware->supports_lnb_control();
    const Error assembled = out.assemble(*out.hardware, *out.hardware);
    if (assembled != Error::OK) return fail(assembled, "assemble");
    return 0;
}


}  // namespace
}  // namespace denpa_asicen

struct denpa_asicen_enclosure {
    std::shared_ptr<denpa_asicen::Core> core;
};

struct denpa_asicen_stream {
    std::shared_ptr<denpa_asicen::Core> core;
    std::uint64_t client = 0U;
    std::uint64_t lease = 0U;
    px4::userland::TunerAttachment attachment{};
    bool attached = false;
};

namespace denpa_asicen {
namespace {

// 取ったものを逆の順で戻す (ストリーム → 取り込みの残り → 受信機)。途中の失敗は標準エラーに出して続ける
void unwind(denpa_asicen_stream& stream) noexcept
{
    auto& tuner = *stream.core->tuner;
    if (stream.attached) {
        const auto stopped = tuner.stop_stream(stream.client, stream.lease);
        if (!stopped && stopped.error() != Error::NOT_READY)
            std::fprintf(stderr, "asicen: stop stream: %s\n", px4::userland::error_string(stopped.error()));
        // 従来の入口のエンジンは HardwareStreamService の後始末の残り (release_final) を呼ばない。呼ばないと次の取り込みが BUSY になる
        (void)stream.core->stream->release_final(stream.attachment);
        stream.attached = false;
    }
    if (stream.lease != 0U) {
        const auto released = tuner.release(stream.client, stream.lease);
        if (!released)
            std::fprintf(stderr, "asicen: release: %s\n", px4::userland::error_string(released.error()));
        stream.lease = 0U;
    }
    (void)tuner.disconnect_client(stream.client);
}

}  // namespace
}  // namespace denpa_asicen

using denpa_asicen::Error;

extern "C" {

int denpa_asicen_abi(void) { return DENPA_ASICEN_ABI; }

const char* denpa_asicen_version(void) { return ASICEN_PROJECT_VERSION; }

const char* denpa_asicen_error_name(int value)
{
    if (value == DENPA_ASICEN_LOADED) return "LOADED";
    if (value < 0 || value > 255) return "UNKNOWN";
    return px4::userland::error_string(static_cast<Error>(value));
}

int denpa_asicen_list_json(char* output, size_t capacity, size_t* length)
{
    // 上流の asicend --list-json (asicend.cpp の list_devices) と同じ並べ方
    if (length == nullptr) return denpa_asicen::code(Error::INVALID_ARGUMENT);
    libusb_context* context = nullptr;
    const int initialized = asicen::initialize_libusb_context(&context);
    if (initialized != 0) return denpa_asicen::code(asicen::map_libusb_error(initialized));
    libusb_device** list = nullptr;
    const ssize_t count = libusb_get_device_list(context, &list);
    if (count < 0) {
        asicen::release_libusb_context(context);
        return denpa_asicen::code(asicen::map_libusb_error(static_cast<int>(count)));
    }
    std::vector<asicen::UsbFunctionObservation> observations;
    bool scan_complete = true;
    for (ssize_t i = 0; i < count; ++i) {
        libusb_device_descriptor descriptor{};
        libusb_device* device = list[i];
        if (libusb_get_device_descriptor(device, &descriptor) != 0) {
            scan_complete = false;
            continue;
        }
        if (asicen::find_profile(descriptor.idVendor, descriptor.idProduct) == nullptr &&
            !(descriptor.idVendor == 0x1738U &&
              (descriptor.idProduct == 0x5211U || descriptor.idProduct == 0x5216U))) continue;
        asicen::UsbFunctionObservation observation;
        observation.vid = descriptor.idVendor;
        observation.pid = descriptor.idProduct;
        observation.bus = libusb_get_bus_number(device);
        observation.address = libusb_get_device_address(device);
        std::uint8_t ports[8]{};
        const int port_count = libusb_get_port_numbers(device, ports, sizeof(ports));
        if (port_count > 0 && port_count <= static_cast<int>(sizeof(ports)))
            observation.port_path.assign(ports, ports + port_count);
        libusb_device* parent = libusb_get_parent(device);
        libusb_device_descriptor parent_descriptor{};
        if (parent != nullptr && libusb_get_device_descriptor(parent, &parent_descriptor) == 0) {
            observation.parent_hub_vid = parent_descriptor.idVendor;
            observation.parent_hub_pid = parent_descriptor.idProduct;
            observation.parent_hub_known = true;
        } else {
            scan_complete = false;
        }
        observations.push_back(std::move(observation));
    }
    libusb_free_device_list(list, 1);
    asicen::release_libusb_context(context);
    const std::string json = asicen::cli::format_discovery_json(observations, scan_complete);
    *length = json.size();
    if (output == nullptr || capacity <= json.size()) return denpa_asicen::code(Error::BUFFER_TOO_SMALL);
    std::memcpy(output, json.data(), json.size());
    output[json.size()] = '\0';
    return 0;
}

int denpa_asicen_open(const char* const* args, int count, denpa_asicen_enclosure** enclosure,
                      char* message_output, size_t message_capacity)
{
    denpa_asicen::Message message(message_output, message_capacity);
    if (enclosure == nullptr || count < 0 || (count > 0 && args == nullptr))
        return denpa_asicen::code(Error::INVALID_ARGUMENT);
    *enclosure = nullptr;
    // 上流の引数の読み方を使う (先頭はプログラム名)
    std::vector<const char*> argv;
    argv.push_back("asicend");
    for (int index = 0; index < count; ++index) argv.push_back(args[index]);
    auto options = asicen::cli::parse_daemon_arguments(static_cast<int>(argv.size()), argv.data());
    if (!options.valid || options.help || options.version || options.list_json || options.models) {
        message.write("argument error: %.*s", static_cast<int>(options.error.size()), options.error.data());
        return denpa_asicen::code(Error::INVALID_ARGUMENT);
    }
    std::shared_ptr<denpa_asicen::Core> core(new (std::nothrow) denpa_asicen::Core());
    if (!core) return denpa_asicen::code(Error::RESOURCE_LIMIT);
    const int opened = denpa_asicen::open_hardware(options, *core, message);
    if (opened != 0) return opened;
    *enclosure = new (std::nothrow) denpa_asicen_enclosure{std::move(core)};
    return *enclosure == nullptr ? denpa_asicen::code(Error::RESOURCE_LIMIT) : 0;
}

#ifdef DENPA_ASICEN_MOCK
int denpa_asicen_open_mock(int receivers, denpa_asicen_enclosure** enclosure)
{
    if (enclosure == nullptr || (receivers != 1 && receivers != 2 && receivers != 4))
        return denpa_asicen::code(Error::INVALID_ARGUMENT);
    *enclosure = nullptr;
    std::shared_ptr<denpa_asicen::Core> core(new (std::nothrow) denpa_asicen::Core());
    if (!core) return denpa_asicen::code(Error::RESOURCE_LIMIT);
    core->mock.reset(new (std::nothrow) asicen::MockTunerBackend(static_cast<std::uint8_t>(receivers)));
    core->capture.reset(new (std::nothrow) denpa_asicen::MockCapture());
    if (!core->mock || !core->capture) return denpa_asicen::code(Error::RESOURCE_LIMIT);
    core->model = "mock";
    core->lnb = true;
    const Error assembled = core->assemble(*core->mock, *core->capture);
    if (assembled != Error::OK) return denpa_asicen::code(assembled);
    *enclosure = new (std::nothrow) denpa_asicen_enclosure{std::move(core)};
    return *enclosure == nullptr ? denpa_asicen::code(Error::RESOURCE_LIMIT) : 0;
}
#endif

int denpa_asicen_model(const denpa_asicen_enclosure* enclosure, char* output, size_t capacity)
{
    if (enclosure == nullptr || output == nullptr) return denpa_asicen::code(Error::INVALID_ARGUMENT);
    const std::string& model = enclosure->core->model;
    if (capacity <= model.size()) return denpa_asicen::code(Error::BUFFER_TOO_SMALL);
    std::memcpy(output, model.data(), model.size());
    output[model.size()] = '\0';
    return 0;
}

int denpa_asicen_receivers(const denpa_asicen_enclosure* enclosure)
{
    return enclosure == nullptr ? 0 : enclosure->core->tuner->receiver_count();
}

int denpa_asicen_receiver_systems(const denpa_asicen_enclosure* enclosure, int receiver)
{
    if (enclosure == nullptr || receiver < 0 || receiver >= enclosure->core->tuner->receiver_count()) return 0;
    const auto& tuner = *enclosure->core->tuner;
    const auto index = static_cast<std::uint8_t>(receiver);
    return (tuner.receiver_supports(index, px4::userland::ipc::System::ISDB_T) ? DENPA_ASICEN_ISDB_T : 0) |
           (tuner.receiver_supports(index, px4::userland::ipc::System::ISDB_S) ? DENPA_ASICEN_ISDB_S : 0);
}

int denpa_asicen_lnb(const denpa_asicen_enclosure* enclosure)
{
    return enclosure != nullptr && enclosure->core->lnb ? 1 : 0;
}

int denpa_asicen_tune(denpa_asicen_enclosure* enclosure, int receiver, int system, uint64_t frequency_hz,
                      uint16_t tsid, uint16_t slot, uint8_t lnb_voltage, uint32_t timeout_ms,
                      denpa_asicen_stream** out)
{
    if (enclosure == nullptr || out == nullptr || receiver < 0 || receiver > 255 ||
        (system != DENPA_ASICEN_ISDB_T && system != DENPA_ASICEN_ISDB_S))
        return denpa_asicen::code(Error::INVALID_ARGUMENT);
    *out = nullptr;
    std::unique_ptr<denpa_asicen_stream> stream(new (std::nothrow) denpa_asicen_stream());
    if (!stream) return denpa_asicen::code(Error::RESOURCE_LIMIT);
    stream->core = enclosure->core;
    auto& core = *stream->core;
    auto& tuner = *core.tuner;
    // 旧来のクライアントの番号の範囲で回す
    stream->client = core.next_client.fetch_add(1U);
    if (stream->client > 0xffffU) {
        core.next_client.store(2U);
        stream->client = 1U;
    }

    const auto acquired = tuner.acquire(stream->client, static_cast<std::uint8_t>(receiver));
    if (!acquired) return denpa_asicen::code(acquired.error());
    stream->lease = acquired.value().lease_id;
    const auto nonce = acquired.value().nonce;

    // 上流のデーモンと同じ Hz の入口。デーモン (dtv-userland-core の control_authority.cpp) は要求を validate_profile で
    // 確かめてから、エンジンの Hz の要求をそのまま受け付けに渡す。ここも同じ確かめ方をして同じ要求を作る
    // (TunerService::prepare_tune_hz はスロットの数をプロファイルで縛り、ASICEN のプロファイルはスロットを持たないので使わない)
    const bool satellite = system == DENPA_ASICEN_ISDB_S;
    Error validation = Error::OK;
    if (!tuner.receiver_supports(static_cast<std::uint8_t>(receiver),
                                 satellite ? px4::userland::ipc::System::ISDB_S : px4::userland::ipc::System::ISDB_T))
        validation = Error::UNSUPPORTED;
    else if (!satellite && (tsid != 0xffffU || slot != 0xffffU || lnb_voltage != 0U))
        validation = Error::INVALID_ARGUMENT;
    else if (satellite && (tsid == 0xffffU) == (slot == 0xffffU))
        validation = Error::INVALID_ARGUMENT;
    else if (lnb_voltage != 0U && (lnb_voltage != 15U || !core.lnb))
        validation = Error::UNSUPPORTED;
    px4::userland::TunerPreparedTune prepared;
    prepared.hz_entrance = true;
    prepared.hz.lease_id = stream->lease;
    prepared.hz.system = satellite ? dtv::userland::detail::ReceiverSystem::satellite
                                   : dtv::userland::detail::ReceiverSystem::terrestrial;
    prepared.hz.requested_hz = frequency_hz;
    prepared.hz.timeout_ms = timeout_ms;
    prepared.hz.stream_id = tsid;
    prepared.hz.slot = slot;
    prepared.hz.lnb_voltage = lnb_voltage;
    prepared.hz.validation = validation;
    const auto admitted = tuner.try_admit_prepared_tune(stream->client, prepared, tuner.monotonic_ms());
    Error failed = Error::OK;
    if (!admitted) {
        failed = admitted.error();
    } else {
        const auto tuned = tuner.execute_admitted_tune(admitted.value());
        if (!tuned) failed = tuned.error();
    }
    if (failed == Error::OK) {
        const auto started = tuner.start_stream(stream->client, stream->lease);
        if (!started) failed = started.error();
    }
    if (failed == Error::OK) {
        const auto attached = tuner.attach_stream(stream->lease, nonce);
        if (!attached) {
            failed = attached.error();
        } else {
            stream->attachment = attached.value();
            stream->attached = true;
        }
    }
    if (failed != Error::OK) {
        denpa_asicen::unwind(*stream);
        return denpa_asicen::code(failed);
    }
    *out = stream.release();
    return 0;
}

int denpa_asicen_read(denpa_asicen_stream* stream, uint8_t* output, size_t capacity, uint32_t timeout_ms,
                      size_t* length, int* ended, int* terminal)
{
    if (stream == nullptr || output == nullptr || length == nullptr || ended == nullptr || terminal == nullptr)
        return denpa_asicen::code(Error::INVALID_ARGUMENT);
    *length = 0U;
    *ended = 0;
    *terminal = 0;
    if (!stream->attached) {
        *ended = 1;
        *terminal = static_cast<int>(px4::userland::TunerStreamTerminal::stopped);
        return 0;
    }
    const auto read = stream->core->stream->read(
        stream->attachment, px4::userland::MutableByteView{output, capacity}, px4::userland::Timeout{timeout_ms});
    if (!read) return denpa_asicen::code(read.error());
    *length = read.value().bytes;
    *ended = read.value().eof ? 1 : 0;
    *terminal = static_cast<int>(read.value().terminal);
    return 0;
}

void denpa_asicen_stop(denpa_asicen_stream* stream)
{
    if (stream == nullptr) return;
    denpa_asicen::unwind(*stream);
    delete stream;
}

void denpa_asicen_close(denpa_asicen_enclosure* enclosure)
{
    // 中身 (Core) は残ったストリームが参照していれば、最後のストリームを止めたときに後片付けされる
    delete enclosure;
}

}  // extern "C"
