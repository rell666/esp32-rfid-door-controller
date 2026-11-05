// Reassembles a message that arrives in chunks (WebSocket fragments / TCP
// segments, or an MQTT payload split by AsyncMqttClient) with a hard size cap.
// Upstream copied chunks into a buffer sized from the first frame and wrote
// later frames past its end; this class bounds every append instead.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>

namespace core
{

// A limit on the bytes held by several buffers together: every WebSocket
// message being assembled or waiting in the queue. Per message the cap is
// 16 KB, but 16 queued messages plus one being assembled per client added up
// to more than the free heap, and a failed allocation aborts the board.
// Lock-free, so the async_tcp task (assembling) and loop() (consuming) can
// share it.
class ByteBudget
{
public:
	explicit ByteBudget(size_t maxBytes) : m_max(maxBytes) {}
	bool take(size_t n)
	{
		size_t cur = m_used.load();
		do
		{
			if (n > m_max - cur)
				return false;
		} while (!m_used.compare_exchange_weak(cur, cur + n));
		return true;
	}
	void give(size_t n) { m_used.fetch_sub(n); }
	size_t used() const { return m_used.load(); }

private:
	size_t m_max;
	std::atomic<size_t> m_used{0};
};

class MessageAssembler
{
public:
	// budget: optional shared limit; the bytes a message holds are charged to
	// it while it is assembled, and handed to the caller by take().
	explicit MessageAssembler(size_t maxBytes, ByteBudget *budget = nullptr) : m_max(maxBytes), m_budget(budget) {}
	~MessageAssembler() { release(); }
	MessageAssembler(const MessageAssembler &) = delete;
	MessageAssembler &operator=(const MessageAssembler &) = delete;

	// Start a new message. A known total length larger than the cap (or than
	// the budget has left) marks the message as overflowed immediately so no
	// memory is reserved for it.
	void reset(size_t expectedTotal = 0)
	{
		m_buf.clear();
		release();
		m_overflow = expectedTotal > m_max;
		m_refused = false;
		if (!m_overflow && expectedTotal > 0)
		{
			if (!charge(expectedTotal))
				return;
			m_buf.reserve(expectedTotal);
		}
	}

	// Append a chunk. Returns false once the message exceeds the cap or the
	// budget; the data collected so far is discarded and further chunks are
	// ignored until reset.
	bool append(const uint8_t *data, size_t len)
	{
		if (m_overflow)
			return false;
		if (len > m_max || m_buf.size() > m_max - len)
		{
			drop();
			return false;
		}
		size_t need = m_buf.size() + len;
		if (need > m_charged && !charge(need - m_charged))
			return false;
		m_buf.append(reinterpret_cast<const char *>(data), len);
		return true;
	}

	// The message was dropped because the shared budget was full (the device
	// is busy), not because it was too large.
	bool refusedByBudget() const { return m_refused; }

	// WebSocket message type (opcode of the message's first frame). Fed every
	// data chunk: a frame that names a type (opcode != 0) starts or restates
	// it; continuation frames (opcode 0) inherit the type recorded so far.
	// ESPAsyncWebServer 3.7.10 fills AwsFrameInfo::message_opcode only when a
	// frame is split across TCP reads, so a small single-frame message reports
	// message_opcode 0 and cannot be classified from that field.
	uint8_t trackType(uint8_t frameOpcode)
	{
		if (frameOpcode != 0)
			m_type = frameOpcode;
		return m_type;
	}

	bool overflowed() const { return m_overflow; }

	// Hand over the completed message (NUL-terminated via std::string) and
	// reset. Returns an empty string if the message overflowed. With a budget,
	// *charged receives the bytes still charged for the message: the caller
	// gives them back once it is done with it (nullptr: given back now).
	std::string take(size_t *charged = nullptr)
	{
		std::string out;
		if (!m_overflow)
			out.swap(m_buf);
		if (charged != nullptr && !m_overflow)
		{
			*charged = m_charged;
			m_charged = 0;
		}
		else if (charged != nullptr)
			*charged = 0;
		reset();
		return out;
	}

private:
	size_t m_max;
	ByteBudget *m_budget;
	size_t m_charged = 0;
	bool m_overflow = false;
	bool m_refused = false;
	uint8_t m_type = 0;
	std::string m_buf;

	bool charge(size_t n)
	{
		if (m_budget == nullptr)
		{
			m_charged += n;
			return true;
		}
		if (!m_budget->take(n))
		{
			drop();
			m_refused = true;
			return false;
		}
		m_charged += n;
		return true;
	}
	void release()
	{
		if (m_budget != nullptr && m_charged > 0)
			m_budget->give(m_charged);
		m_charged = 0;
	}
	void drop()
	{
		m_overflow = true;
		m_buf.clear();
		m_buf.shrink_to_fit();
		release();
	}
};

} // namespace core
