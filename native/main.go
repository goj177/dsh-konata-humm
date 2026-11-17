package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"time"

	"github.com/ebitengine/oto/v3"
)

type track struct {
	pcm        []byte
	sampleRate int
	channels   int
}

func readTrack(path string) (track, error) {
	var audio track
	data, err := os.ReadFile(path)
	if err != nil {
		return audio, err
	}
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return audio, errors.New("expected a PCM WAV audio file")
	}
	for offset := 12; offset+8 <= len(data); {
		name := string(data[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		offset += 8
		if size > len(data)-offset {
			return audio, errors.New("truncated WAV chunk")
		}
		chunk := data[offset : offset+size]
		switch name {
		case "fmt ":
			if len(chunk) < 16 || binary.LittleEndian.Uint16(chunk) != 1 ||
				binary.LittleEndian.Uint16(chunk[14:]) != 16 {
				return audio, errors.New("expected 16-bit PCM audio")
			}
			audio.channels = int(binary.LittleEndian.Uint16(chunk[2:]))
			audio.sampleRate = int(binary.LittleEndian.Uint32(chunk[4:]))
		case "data":
			audio.pcm = chunk
		}
		offset += size + size%2
	}
	if audio.channels < 1 || audio.channels > 2 || audio.sampleRate < 8000 || audio.sampleRate > 192000 ||
		len(audio.pcm) == 0 || len(audio.pcm)%(2*audio.channels) != 0 {
		return audio, errors.New("invalid WAV format or empty audio")
	}
	return audio, nil
}

type loopReader struct {
	pcm    []byte
	offset int
}

func (source *loopReader) Read(output []byte) (int, error) {
	for written := 0; written < len(output); {
		size := copy(output[written:], source.pcm[source.offset:])
		written += size
		source.offset = (source.offset + size) % len(source.pcm)
	}
	return len(output), nil
}

type volumeRamp struct {
	from, to   float64
	start, end time.Time
}

func (ramp volumeRamp) value(at time.Time) float64 {
	if !at.Before(ramp.end) {
		return ramp.to
	}
	return ramp.from + (ramp.to-ramp.from)*float64(at.Sub(ramp.start))/float64(ramp.end.Sub(ramp.start))
}

type player struct {
	context                  *oto.Context
	audio                    track
	current                  *oto.Player
	volume                   float64
	fadeIn, fadeOut          time.Duration
	started, minimumPlayback time.Time
	stopAt                   time.Time
	fading, quitting         bool
	ramp                     volumeRamp
}

func (p *player) fade(to float64, duration time.Duration, now time.Time) {
	p.ramp = volumeRamp{p.ramp.value(now), to, now, now.Add(duration)}
	p.current.SetVolume(p.ramp.value(now))
}

func (p *player) start(now time.Time) {
	p.stopAt = time.Time{}
	p.fading = false
	if p.current == nil {
		p.current = p.context.NewPlayer(&loopReader{pcm: p.audio.pcm})
		p.current.SetVolume(0)
		p.current.Play()
		p.started = now
		p.minimumPlayback = now.Add(max(180*time.Millisecond, p.fadeIn))
		p.ramp = volumeRamp{}
		p.report("playing", now)
	}
	p.fade(p.volume, p.fadeIn, now)
}

func (p *player) report(event string, now time.Time) {
	bytesPerSecond := p.audio.sampleRate * p.audio.channels * 2
	duration := time.Second * time.Duration(len(p.audio.pcm)) / time.Duration(bytesPerSecond)
	fmt.Printf("%s %.6f\n", event, (now.Sub(p.started) % duration).Seconds())
}

func (p *player) tick(now time.Time) error {
	if err := p.current.Err(); err != nil {
		return err
	}
	if !p.stopAt.IsZero() && !now.Before(p.stopAt) {
		p.stopAt = time.Time{}
		p.fading = true
		p.fade(0, p.fadeOut, now)
		p.report("fading", now)
	}
	p.current.SetVolume(p.ramp.value(now))
	if p.fading && !now.Before(p.ramp.end) {
		p.current.Pause()
		p.current = nil
		p.report("stopped", now)
	}
	return nil
}

func (p *player) run() error {
	commands := make(chan string)
	go func() {
		defer close(commands)
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			command := scanner.Text()
			commands <- command
			if command == "quit" {
				return
			}
		}
	}()
	ticker := time.NewTicker(8 * time.Millisecond)
	defer ticker.Stop()
	for {
		var ticks <-chan time.Time
		if p.current != nil {
			ticks = ticker.C
		} else if p.quitting {
			return nil
		}
		select {
		case command, open := <-commands:
			now := time.Now()
			if !open || command == "quit" {
				p.quitting = true
				commands = nil
				command = "stop"
			}
			switch command {
			case "start":
				p.start(now)
			case "stop":
				if p.current != nil && !p.fading && p.stopAt.IsZero() {
					p.stopAt = now
					if p.minimumPlayback.After(now) {
						p.stopAt = p.minimumPlayback
					}
				}
			}
		case <-ticks:
			if err := p.tick(time.Now()); err != nil {
				return err
			}
		}
	}
}

func run(args []string) error {
	if len(args) != 4 {
		return errors.New("expected audio path, volume, fade-in and fade-out")
	}
	audio, err := readTrack(args[0])
	if err != nil {
		return err
	}
	volume, volumeErr := strconv.ParseFloat(args[1], 64)
	fadeIn, inErr := strconv.Atoi(args[2])
	fadeOut, outErr := strconv.Atoi(args[3])
	if volumeErr != nil || math.IsNaN(volume) || volume < 0 || volume > 1 ||
		inErr != nil || fadeIn < 0 || fadeIn > 5000 || outErr != nil || fadeOut < 0 || fadeOut > 5000 {
		return errors.New("invalid playback settings")
	}
	context, ready, err := oto.NewContext(&oto.NewContextOptions{
		SampleRate: audio.sampleRate, ChannelCount: audio.channels, Format: oto.FormatSignedInt16LE,
		BufferSize: 40 * time.Millisecond,
	})
	if err != nil {
		return err
	}
	<-ready
	if err := context.Err(); err != nil {
		return err
	}
	return (&player{
		context: context, audio: audio, volume: volume,
		fadeIn: time.Duration(fadeIn) * time.Millisecond, fadeOut: time.Duration(fadeOut) * time.Millisecond,
	}).run()
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
