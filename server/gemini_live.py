import asyncio
import inspect
import logging
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

class GeminiLive:
    """
    Handles the interaction with the Gemini Live API.
    """
    def __init__(
        self,
        project_id,
        location,
        model,
        input_sample_rate,
        tools=None,
        tool_mapping=None,
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        compression_trigger_tokens=None,
        compression_target_tokens=None,
        enable_context_window_compression=True,
        enable_transcriptions=True,
        enable_proactive_audio=False,
        api_version="v1",
        voice_name="Zephyr",
        system_instruction_text=(
            "You are an AI assistant that teaches users how to cook pasta. "
            "Provide practical, step-by-step guidance with clear timings."
        ),
        english_only=True,
    ):
        """
        Initializes the GeminiLive client.

        Args:
            project_id (str): The Google Cloud Project ID.
            location (str): The Google Cloud Location (e.g., "us-central1").
            model (str): The model name to use.
            input_sample_rate (int): The sample rate for audio input.
            tools (list, optional): List of tools to enable. Defaults to None.
            tool_mapping (dict, optional): Mapping of tool names to functions. Defaults to None.
        """
        self.project_id = project_id
        self.location = location
        # Vertex model ids should not include the "models/" prefix.
        if isinstance(model, str) and model.startswith("models/"):
            logger.warning(
                "MODEL '%s' includes 'models/' prefix for Vertex; stripping to '%s'",
                model,
                model.split("/", 1)[1],
            )
            model = model.split("/", 1)[1]
        self.model = model
        self.input_sample_rate = input_sample_rate
        self.api_version = api_version
        client_kwargs = dict(
            vertexai=True,
            project=project_id,
            location=location,
        )
        if self.api_version:
            client_kwargs["http_options"] = {"api_version": self.api_version}
        self.client = genai.Client(**client_kwargs)
        self.tools = tools or []
        self.tool_mapping = tool_mapping or {}
        if isinstance(media_resolution, str):
            self.media_resolution = getattr(
                types.MediaResolution,
                media_resolution,
                types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
            )
        else:
            self.media_resolution = media_resolution
        self.compression_trigger_tokens = compression_trigger_tokens
        self.compression_target_tokens = compression_target_tokens
        self.enable_context_window_compression = enable_context_window_compression
        self.enable_transcriptions = enable_transcriptions
        self.enable_proactive_audio = enable_proactive_audio
        self.voice_name = voice_name
        self.system_instruction_text = system_instruction_text
        self.english_only = english_only

    async def start_session(
        self,
        audio_input_queue,
        video_input_queue,
        text_input_queue,
        audio_output_callback,
        audio_interrupt_callback=None,
        session_resumption_handle=None,
    ):
        instruction_text = self.system_instruction_text
        if self.english_only:
            instruction_text = (
                f"{instruction_text}\n\nRESPOND IN ENGLISH. YOU MUST RESPOND UNMISTAKABLY IN ENGLISH."
            )

        context_window_compression = None
        if self.enable_context_window_compression:
            compression_kwargs = {}
            if self.compression_trigger_tokens is not None:
                compression_kwargs["trigger_tokens"] = self.compression_trigger_tokens

            sliding_window_kwargs = {}
            if self.compression_target_tokens is not None:
                sliding_window_kwargs["target_tokens"] = self.compression_target_tokens

            compression_kwargs["sliding_window"] = types.SlidingWindow(
                **sliding_window_kwargs
            )
            context_window_compression = types.ContextWindowCompressionConfig(
                **compression_kwargs
            )

        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            media_resolution=self.media_resolution,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.voice_name
                    )
                )
            ),
            system_instruction=types.Content(
                role="user",
                parts=[types.Part.from_text(text=instruction_text)],
            ),
            input_audio_transcription=(
                types.AudioTranscriptionConfig() if self.enable_transcriptions else None
            ),
            output_audio_transcription=(
                types.AudioTranscriptionConfig() if self.enable_transcriptions else None
            ),
            proactivity=(
                types.ProactivityConfig(proactive_audio=True)
                if self.enable_proactive_audio
                else None
            ),
            # Keep long-running conversations healthy and resumable.
            context_window_compression=context_window_compression,
            session_resumption=types.SessionResumptionConfig(
                transparent=True,
                handle=session_resumption_handle,
            ),
            tools=self.tools,
        )
        logger.debug(
            "Starting Live session model=%s location=%s api_version=%s media_resolution=%s resume=%s compression=%s trigger=%s target=%s",
            self.model,
            self.location,
            self.api_version,
            self.media_resolution,
            bool(session_resumption_handle),
            bool(self.enable_context_window_compression),
            self.compression_trigger_tokens,
            self.compression_target_tokens,
        )
        
        async with self.client.aio.live.connect(model=self.model, config=config) as session:
            outgoing_queue = asyncio.Queue()
            
            async def send_audio():
                try:
                    while True:
                        chunk = await audio_input_queue.get()
                        await outgoing_queue.put(
                            {
                                "kind": "audio",
                                "chunk": chunk,
                            }
                        )
                except asyncio.CancelledError:
                    pass

            async def send_video():
                try:
                    while True:
                        chunk = await video_input_queue.get()
                        await outgoing_queue.put(
                            {
                                "kind": "video",
                                "chunk": chunk,
                            }
                        )
                except asyncio.CancelledError:
                    pass

            async def send_text():
                try:
                    while True:
                        text = await text_input_queue.get()
                        await outgoing_queue.put(
                            {
                                "kind": "text",
                                "text": text,
                            }
                        )
                except asyncio.CancelledError:
                    pass

            async def send_outgoing():
                try:
                    while True:
                        message = await outgoing_queue.get()
                        kind = message.get("kind")
                        if kind == "audio":
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    data=message["chunk"],
                                    mime_type=f"audio/pcm;rate={self.input_sample_rate}",
                                )
                            )
                        elif kind == "video":
                            await session.send_realtime_input(
                                video=types.Blob(
                                    data=message["chunk"],
                                    mime_type="image/jpeg",
                                )
                            )
                        elif kind == "text":
                            await session.send(input=message["text"], end_of_turn=True)
                except asyncio.CancelledError:
                    pass

            event_queue = asyncio.Queue()

            async def receive_loop():
                try:
                    async for response in session.receive():
                        server_content = response.server_content
                        tool_call = response.tool_call
                        session_resumption_update = response.session_resumption_update
                        go_away = response.go_away
                        
                        if session_resumption_update:
                            await event_queue.put({
                                "type": "session_resumption_update",
                                "resumable": bool(session_resumption_update.resumable),
                                "new_handle": session_resumption_update.new_handle,
                                "last_consumed_client_message_index": session_resumption_update.last_consumed_client_message_index,
                            })

                        if go_away:
                            await event_queue.put({
                                "type": "go_away",
                                "time_left": go_away.time_left,
                            })
                        
                        if server_content:
                            if server_content.model_turn:
                                for part in server_content.model_turn.parts:
                                    if part.inline_data:
                                        if inspect.iscoroutinefunction(audio_output_callback):
                                            await audio_output_callback(part.inline_data.data)
                                        else:
                                            audio_output_callback(part.inline_data.data)
                            
                            if server_content.input_transcription and server_content.input_transcription.text:
                                await event_queue.put({"type": "user", "text": server_content.input_transcription.text})
                            
                            if server_content.output_transcription and server_content.output_transcription.text:
                                await event_queue.put({"type": "gemini", "text": server_content.output_transcription.text})
                            
                            if server_content.turn_complete:
                                await event_queue.put({"type": "turn_complete"})
                            
                            if server_content.interrupted:
                                if audio_interrupt_callback:
                                    if inspect.iscoroutinefunction(audio_interrupt_callback):
                                        await audio_interrupt_callback()
                                    else:
                                        audio_interrupt_callback()
                                await event_queue.put({"type": "interrupted"})

                        if tool_call:
                            function_responses = []
                            for fc in tool_call.function_calls:
                                func_name = fc.name
                                args = fc.args or {}
                                
                                if func_name in self.tool_mapping:
                                    try:
                                        tool_func = self.tool_mapping[func_name]
                                        if inspect.iscoroutinefunction(tool_func):
                                            result = await tool_func(**args)
                                        else:
                                            loop = asyncio.get_running_loop()
                                            result = await loop.run_in_executor(None, lambda: tool_func(**args))
                                    except Exception as e:
                                        result = f"Error: {e}"
                                    
                                    function_responses.append(types.FunctionResponse(
                                        name=func_name,
                                        id=fc.id,
                                        response={"result": result}
                                    ))
                                    await event_queue.put({"type": "tool_call", "name": func_name, "args": args, "result": result})
                            
                            await session.send_tool_response(function_responses=function_responses)

                except Exception as e:
                    logger.exception("Gemini receive loop failed")
                    await event_queue.put(
                        {"type": "error", "error": f"{type(e).__name__}: {e}"}
                    )
                finally:
                    await event_queue.put(None)

            send_audio_task = asyncio.create_task(send_audio())
            send_video_task = asyncio.create_task(send_video())
            send_text_task = asyncio.create_task(send_text())
            send_outgoing_task = asyncio.create_task(send_outgoing())
            receive_task = asyncio.create_task(receive_loop())

            try:
                while True:
                    event = await event_queue.get()
                    if event is None:
                        break
                    if isinstance(event, dict) and event.get("type") == "error":
                        # Just yield the error event, don't raise to keep the stream alive if possible or let caller handle
                        yield event
                        break 
                    yield event
            finally:
                send_audio_task.cancel()
                send_video_task.cancel()
                send_text_task.cancel()
                send_outgoing_task.cancel()
                receive_task.cancel()
