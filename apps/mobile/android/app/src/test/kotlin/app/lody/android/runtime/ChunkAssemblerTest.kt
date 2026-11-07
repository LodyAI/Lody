package app.lody.android.runtime
import org.junit.Assert.*
import org.junit.Test
class ChunkAssemblerTest {
 @Test fun reassemblesLargeUnicodeMessages() {
  val a=ChunkAssembler();val text="中文😀".repeat(180000);val chunks=text.chunked(16384);var result:String?=null
  chunks.forEachIndexed {i,part->result=a.add("one",i,chunks.size,part,0)}
  assertTrue(text==result)
 }
 @Test fun duplicateOutOfOrderAndOversizedChunksAreRejected() {
  val a=ChunkAssembler();a.add("one",0,2,"first",0)
  assertThrows(IllegalArgumentException::class.java){a.add("one",0,2,"duplicate",0)}
  assertThrows(IllegalArgumentException::class.java){a.add("two",1,2,"late",0)}
  assertThrows(IllegalArgumentException::class.java){a.add("three",0,999999,"oversized",0)}
 }
 @Test fun partialMessagesKeepTheirRemainingDeadlineAcrossBackground() {
  val a=ChunkAssembler();a.add("one",0,2,"first",0)
  a.suspend(1000);assertFalse(a.expire(9000))
  a.resume(10000);assertFalse(a.expire(13999))
  assertEquals("firstlast",a.add("one",1,2,"last",13999))
  a.suspend(14000);a.add("two",0,2,"a",20000);a.resume(30000)
  assertFalse(a.expire(34999));assertTrue(a.expire(35000))
 }
 @Test fun abandonedAssemblyExpiresAndStopClearsIt() {
  val a=ChunkAssembler();a.add("one",0,2,"first",0)
  assertFalse(a.expire(4999));assertTrue(a.expire(5000))
  a.add("two",0,2,"first",6000);a.clear();assertFalse(a.expire(12000))
 }
}
